import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  renameSync,
  copyFileSync,
  readdirSync
} from 'fs'
import { join, basename, dirname, relative, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import type {
  AppSettings,
  BackupManifest,
  BackupRestorePreview,
  BackupRestoreResult,
  BackupRestoreSection
} from '@shared/types'
import {
  backupDir,
  deleteBackup,
  insertBackup,
  listBackups,
  loadInstanceConfigs,
  loadSettings,
  saveSettings,
  listRemotes,
  listModels,
  listWorkflows,
  listNodePacks,
  listSnapshots,
  replaceList,
  userDataDir,
  workflowLibraryDir
} from './db'
import {
  sanitizeId,
  isPathInside,
  resolveInsideAnyRoot,
  assertSafeEndpointSetting,
  assertSafeSettingsPatch,
  assertSafeRelativeFilename,
  isSafeExternalUrl
} from './security'
import { encryptSecret } from './secretStorage'

function resolveBackupDir(id: string): string {
  const safe = sanitizeId(id)
  const dir = join(backupDir(), safe)
  if (!isPathInside(dir, backupDir())) {
    throw new Error('Invalid backup id')
  }
  return dir
}

/** Sections a restore can apply selectively (0.1.18 WP7 preview/selection). */
const ALL_SECTIONS: BackupRestoreSection[] = [
  'settings',
  'instances',
  'nodePacks',
  'models',
  'workflows',
  'remotes',
  'snapshots'
]

interface PlanFile {
  id: string
  name: string
  /** Absolute destination computed from a trusted root — never the backup's raw path. */
  target: string
  remapped: boolean
  missing: boolean
  source?: string
}

interface RestorePlan {
  id: string
  name: string
  settings?: AppSettings
  lists: Partial<Record<BackupRestoreSection, unknown[]>>
  files: PlanFile[]
  invalidPaths: string[]
  warnings: string[]
  parseErrors: string[]
  settingsChanged: string[]
  counts: Record<string, number>
}

/**
 * Roots a restored path may resolve under.
 *
 * 0.1.18 (WP1): `backup.restore` used to trust `workflows[].path` verbatim —
 * `copyFileSync(attackerFile, wf.path)` with no containment check is an
 * arbitrary-file-write primitive triggered by importing someone's backup.
 */
function restoreRoots(): string[] {
  const roots: string[] = []
  try {
    roots.push(userDataDir(), workflowLibraryDir())
  } catch {
    /* ignore */
  }
  for (const c of loadInstanceConfigs()) {
    if (!c.path) continue
    roots.push(c.path, join(c.path, 'user', 'default', 'workflows'))
  }
  for (const r of loadSettings().modelScanRoots || []) {
    if (r) roots.push(r)
  }
  return [...new Set(roots.filter(Boolean))]
}

/**
 * 0.1.18 (regression): workflow FILES may only be written into a workflow
 * directory — the library or `<instance>/user/default/workflows`. The old
 * "trusted root" list contained the whole instance directory, so a crafted
 * backup could overwrite `<ComfyUI>/main.py` (code execution on next launch).
 */
function workflowRestoreRoots(): string[] {
  const roots: string[] = []
  try {
    roots.push(workflowLibraryDir())
  } catch {
    /* ignore */
  }
  for (const c of loadInstanceConfigs()) {
    if (c.path) roots.push(join(c.path, 'user', 'default', 'workflows'))
  }
  return [...new Set(roots.filter(Boolean))]
}

function safeSegments(rel: string): string[] | null {
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  if (!segments.length) return null
  const safe: string[] = []
  for (const segment of segments) {
    try {
      safe.push(assertSafeRelativeFilename(segment))
    } catch {
      return null
    }
  }
  return safe
}

/**
 * Map a backed-up workflow path into a WRITABLE workflow location.
 *  - inside a known workflow root → keep the relative structure;
 *  - otherwise (or on any unsafe segment) → library root, collision-suffixed.
 */
function workflowTargetFor(
  rawPath: string,
  wfId: string,
  roots: string[],
  libraryRoot: string
): { target: string; remapped: boolean } {
  for (const root of roots) {
    const rel = relative(root, rawPath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    const segments = safeSegments(rel)
    if (!segments) continue
    const target = join(root, ...segments)
    if (!resolveInsideAnyRoot(target, [root])) continue
    return { target, remapped: false }
  }
  let name: string
  try {
    name = assertSafeRelativeFilename(basename(rawPath))
  } catch {
    name = `${sanitizeId(wfId)}.json`
  }
  let target = join(libraryRoot, name)
  if (existsSync(target)) {
    const ext = name.toLowerCase().endsWith('.json') ? '.json' : ''
    const stem = ext ? name.slice(0, -ext.length) : name
    target = join(libraryRoot, `${stem}-${sanitizeId(wfId).slice(0, 8)}${ext}`)
  }
  return { target, remapped: true }
}

function matchRoot(candidate: string, roots: string[]): string | null {
  for (const root of roots) {
    if (resolveInsideAnyRoot(candidate, [root])) return root
  }
  return null
}

/** Keys a restored settings object would actually change. */
function changedSettingKeys(next: AppSettings, current: AppSettings): string[] {
  const keys = new Set([...Object.keys(next), ...Object.keys(current)]) as Set<keyof AppSettings>
  const changed: string[] = []
  for (const key of keys) {
    if (key === 'proxy') continue
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) changed.push(String(key))
  }
  const np = next.proxy || ({} as AppSettings['proxy'])
  const cp = current.proxy || ({} as AppSettings['proxy'])
  for (const key of new Set([...Object.keys(np), ...Object.keys(cp)]) as Set<
    keyof AppSettings['proxy']
  >) {
    if (key === 'password') continue
    if (JSON.stringify(np[key]) !== JSON.stringify(cp[key])) changed.push(`proxy.${String(key)}`)
  }
  return changed.sort()
}

/**
 * Copy every workflow entity file referenced by the manifest into
 * `<backup>/workflow-files/<id>/<basename>`. Missing files are recorded
 * but do not abort the backup (the metadata list is still saved).
 */
function snapshotWorkflowFiles(dir: string): { copied: number; missing: number } {
  const wfDir = join(dir, 'workflow-files')
  mkdirSync(wfDir, { recursive: true })
  let copied = 0
  let missing = 0
  for (const wf of listWorkflows()) {
    if (!wf.path || !existsSync(wf.path)) {
      missing += 1
      continue
    }
    const safeId = sanitizeId(wf.id)
    const targetDir = join(wfDir, safeId)
    mkdirSync(targetDir, { recursive: true })
    try {
      copyFileSync(wf.path, join(targetDir, basename(wf.path)))
      copied += 1
    } catch {
      missing += 1
    }
  }
  return { copied, missing }
}

/**
 * Restore workflow entity files from `<backup>/workflow-files/<id>/<file>`.
 * Writes into a staging directory first, then swaps — a crash mid-restore
 * never leaves a half-written file at the final path.
 *
 * 0.1.18 (WP1): the destination always comes from `plan.files` (already
 * re-rooted under a trusted directory); the raw `wf.path` from the backup is
 * never used as a write target.
 */
function restoreWorkflowFiles(files: PlanFile[]): { restored: number; failed: number } {
  let restored = 0
  let failed = 0
  for (const file of files) {
    if (!file.source || file.missing) continue
    const dest = file.target
    const staging = `${dest}.restore-tmp-${process.pid}`
    try {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file.source, staging)
      renameSync(staging, dest)
      restored += 1
    } catch {
      failed += 1
      try {
        if (existsSync(staging)) rmSync(staging, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
  return { restored, failed }
}

/**
 * 0.1.18 (review round 2): a restore used to apply settings/lists/files one by
 * one with no rollback — a failure halfway left a half-restored profile whose
 * lists pointed at files that were never written. Capture the current state
 * first so a thrown error can be reverted in place.
 */
interface RestoreSnapshot {
  settings: AppSettings
  instances: unknown[]
  nodePacks: unknown[]
  models: unknown[]
  snapshots: unknown[]
  remotes: Array<Record<string, unknown>>
  workflows: unknown[]
  files: Array<{ target: string; data: Buffer | null }>
}

function captureRestoreSnapshot(files: PlanFile[]): RestoreSnapshot {
  const readIf = (target: string): Buffer | null => {
    try {
      return existsSync(target) ? readFileSync(target) : null
    } catch {
      return null
    }
  }
  return {
    settings: loadSettings(),
    instances: loadInstanceConfigs() as unknown[],
    nodePacks: listNodePacks() as unknown[],
    models: listModels() as unknown[],
    snapshots: listSnapshots() as unknown[],
    // `listRemotes()` returns decrypted keys; encrypt again before writing back
    // (see the restore path above — plaintext on disk is what WP8 removed).
    remotes: listRemotes().map((r) => ({ ...r })),
    workflows: listWorkflows() as unknown[],
    files: files
      .filter((f) => !f.missing)
      .map((f) => ({ target: f.target, data: readIf(f.target) }))
  }
}

function applyRestoreSnapshot(snap: RestoreSnapshot): void {
  saveSettings(snap.settings)
  replaceList('instances', snap.instances)
  replaceList('node_packs', snap.nodePacks)
  replaceList('models', snap.models)
  replaceList('node_snapshots', snap.snapshots)
  replaceList(
    'remote_instances',
    snap.remotes.map((r) => ({
      ...r,
      apiKey: r.apiKey ? encryptSecret(String(r.apiKey)) : ''
    }))
  )
  replaceList('workflows', snap.workflows)
  for (const f of snap.files) {
    try {
      if (f.data === null) {
        if (existsSync(f.target)) rmSync(f.target, { force: true })
      } else {
        mkdirSync(dirname(f.target), { recursive: true })
        writeFileSync(f.target, f.data)
      }
    } catch {
      /* best effort — the pre-restore backup remains the recovery path */
    }
  }
}

export class BackupService {
  list(): BackupManifest[] {
    return listBackups()
  }

  create(opts: { name: string; notes?: string }): BackupManifest {
    const id = sanitizeId(randomUUID())
    const dir = join(backupDir(), id)
    mkdirSync(dir, { recursive: true })

    const settings = loadSettings()
    const instances = loadInstanceConfigs()
    const nodePacks = listNodePacks()
    const models = listModels()
    const workflows = listWorkflows()
    const remotes = listRemotes()
    const snapshots = listSnapshots()

    // 0.1.17 (WP8): a backup is a plain folder users copy around / upload for
    // support. Credentials must never leave the machine in it.
    const safeSettings: AppSettings = {
      ...settings,
      proxy: { ...settings.proxy, password: '' }
    }
    const safeRemotes = remotes.map((r) => ({ ...r, apiKey: '' }))

    const files: Record<string, unknown> = {
      'settings.json': safeSettings,
      'instances.json': instances,
      'node-packs.json': nodePacks,
      'model-manifest.json': models,
      'workflows.json': workflows,
      'remote-instances.json': safeRemotes,
      'node-snapshots.json': snapshots
    }
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
    }

    // Real workflow entity files — metadata alone leaves dangling paths on restore.
    const wfResult = snapshotWorkflowFiles(dir)

    const includes = {
      settings: true,
      instances: true,
      nodePacks: true,
      modelManifest: true,
      workflows: true,
      workflowFiles: wfResult.copied > 0,
      nodeSnapshots: true
    }

    let size = 0
    for (const f of Object.keys(files)) {
      try {
        size += statSync(join(dir, f)).size
      } catch {
        /* ignore */
      }
    }
    // Include workflow-files size
    try {
      const wfDir = join(dir, 'workflow-files')
      if (existsSync(wfDir)) {
        const walk = (d: string): number => {
          let s = 0
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name)
            if (e.isDirectory()) s += walk(p)
            else s += statSync(p).size
          }
          return s
        }
        size += walk(wfDir)
      }
    } catch {
      /* ignore */
    }

    const manifest: BackupManifest = {
      id,
      name: opts.name || `backup-${new Date().toISOString().slice(0, 10)}`,
      createdAt: Date.now(),
      path: dir,
      size,
      includes,
      notes:
        (opts.notes || '') +
        (wfResult.missing ? ` (${wfResult.missing} workflow files missing)` : '') +
        ' (credentials excluded — proxy password / remote API keys stay local)'
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    insertBackup(manifest)
    return manifest
  }

  /**
   * Parse + validate a backup without applying anything (0.1.18 WP1/WP7).
   * The UI shows this before a destructive restore, and `restore()` uses the
   * exact same plan so preview and apply can never disagree.
   */
  preview(id: string): BackupRestorePreview {
    const plan = this.buildPlan(id)
    const manifest = listBackups().find((b) => b.id === sanitizeId(id))
    return {
      id: sanitizeId(id),
      name: manifest?.name || plan.name,
      counts: plan.counts,
      settingsChanged: plan.settingsChanged,
      workflowFiles: plan.files.map((f) => ({
        id: f.id,
        name: f.name,
        target: f.target,
        remapped: f.remapped,
        missing: f.missing
      })),
      invalidPaths: plan.invalidPaths,
      warnings: [...plan.warnings, ...plan.parseErrors],
      canRestore: plan.invalidPaths.length === 0 && plan.parseErrors.length === 0
    }
  }

  restore(id: string, opts?: { sections?: BackupRestoreSection[] }): BackupRestoreResult {
    const plan = this.buildPlan(id)
    if (plan.parseErrors.length) {
      throw new Error(`Backup restore aborted, nothing applied — ${plan.parseErrors.join('; ')}`)
    }
    if (plan.invalidPaths.length) {
      throw new Error(
        `Backup restore aborted, nothing applied — paths outside this machine's known roots: ${plan.invalidPaths.join('; ')}`
      )
    }
    const sections = new Set<BackupRestoreSection>(
      (opts?.sections || ALL_SECTIONS).filter((s) => ALL_SECTIONS.includes(s))
    )

    // Settings first: it carries roots used by later operations.
    const snapshot = captureRestoreSnapshot(plan.files)
    let preRestoreId = ''
    try {
      preRestoreId = this.create({
        name: `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        notes: `Automatic snapshot before restoring ${sanitizeId(id)}`
      }).id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Restore aborted, nothing applied — could not create the pre-restore backup (${msg})`
      )
    }

    try {
      if (sections.has('settings') && plan.settings) {
        const current = loadSettings()
        const nextSettings: AppSettings = { ...plan.settings }
        // 0.1.17 (WP8): the snapshot never contains credentials. Keep whatever
        // this machine already had instead of wiping the proxy password.
        if (!plan.settings.proxy?.password && current.proxy?.password) {
          nextSettings.proxy = { ...plan.settings.proxy, password: current.proxy.password }
        }
        saveSettings(nextSettings)
      }

      const listFor = (section: BackupRestoreSection): unknown[] | undefined => plan.lists[section]

      if (sections.has('instances') && listFor('instances')) {
        replaceList('instances', listFor('instances') as unknown[])
      }
      if (sections.has('nodePacks') && listFor('nodePacks')) {
        replaceList('node_packs', listFor('nodePacks') as unknown[])
      }
      if (sections.has('models') && listFor('models')) {
        replaceList('models', listFor('models') as unknown[])
      }
      if (sections.has('snapshots') && listFor('snapshots')) {
        replaceList('node_snapshots', listFor('snapshots') as unknown[])
      }
      if (sections.has('remotes') && listFor('remotes')) {
        const localKeys = new Map(listRemotes().map((r) => [r.id, r.apiKey]))
        const items = (listFor('remotes') as Array<Record<string, unknown>>).map((r) => {
          // 0.1.17 (review fix): the backup strips apiKey, so the merge brings
          // back THIS machine's decrypted key — it must be re-encrypted before
          // hitting disk, otherwise a restore silently degrades the credential
          // to plaintext (the very thing WP8 removed).
          const { apiKeyLocked: _ignored, ...rest } = r
          const plain = String(r.apiKey || '') || localKeys.get(String(r.id)) || ''
          return { ...rest, apiKey: plain ? encryptSecret(plain) : '' }
        })
        replaceList('remote_instances', items)
      }
      if (sections.has('workflows') && listFor('workflows')) {
        // Workflow records are re-pathed to the validated destinations.
        const byId = new Map(plan.files.map((f) => [f.id, f]))
        const items = (listFor('workflows') as Array<Record<string, unknown>>).map((wf) => {
          const planned = byId.get(String(wf.id))
          return planned ? { ...wf, path: planned.target } : wf
        })
        replaceList('workflows', items)
      }

      const wfResult = sections.has('workflows')
        ? restoreWorkflowFiles(plan.files.filter((f) => !f.missing))
        : { restored: 0, failed: 0 }

      if (wfResult.failed > 0) {
        throw new Error(`${wfResult.failed} workflow file(s) could not be written`)
      }

      return {
        ok: true,
        restored: wfResult.restored,
        failed: 0,
        warnings: plan.warnings,
        preRestoreId
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      try {
        applyRestoreSnapshot(snapshot)
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr)
        throw new Error(
          `Restore failed (${msg}) and the automatic rollback also failed (${rbMsg}). Pre-restore backup ${preRestoreId} is intact.`
        )
      }
      throw new Error(
        `Restore failed and was rolled back: ${msg}. Pre-restore backup: ${preRestoreId}`
      )
    }
  }

  private buildPlan(id: string): RestorePlan {
    const dir = resolveBackupDir(id)
    if (!existsSync(dir)) throw new Error('Backup not found')

    const parseErrors: string[] = []
    const warnings: string[] = []
    let settings: AppSettings | undefined
    const lists: Partial<Record<BackupRestoreSection, unknown[]>> = {}
    const counts: Record<string, number> = {}

    const parseFile = (name: string): unknown => {
      const file = join(dir, name)
      if (!existsSync(file)) return undefined
      try {
        return JSON.parse(readFileSync(file, 'utf-8'))
      } catch (e) {
        parseErrors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      }
    }

    const settingsVal = parseFile('settings.json')
    if (settingsVal !== undefined) {
      if (settingsVal && typeof settingsVal === 'object' && !Array.isArray(settingsVal)) {
        settings = settingsVal as AppSettings
      } else {
        parseErrors.push('settings.json: expected object')
      }
    }
    if (settings) {
      // A backup may not flip the runtime-integrity escape hatch: that is
      // local security state, exactly like settings.importConfig treats it.
      if ('allowUnverifiedRuntime' in (settings as unknown as Record<string, unknown>)) {
        delete (settings as unknown as Record<string, unknown>).allowUnverifiedRuntime
        warnings.push('settings.json: allowUnverifiedRuntime is local security state — ignored')
      }
      const endpointKeys = [
        'githubEndpoint',
        'hfEndpoint',
        'civitaiEndpoint',
        'pipIndex',
        'torchIndexMirror'
      ] as const
      for (const key of endpointKeys) {
        try {
          assertSafeEndpointSetting(key, (settings as unknown as Record<string, unknown>)[key])
        } catch (e) {
          parseErrors.push(`settings.json: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      try {
        assertSafeSettingsPatch(settings as unknown as Record<string, unknown>)
      } catch (e) {
        parseErrors.push(`settings.json: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const listEntries: Array<[string, BackupRestoreSection]> = [
      ['instances.json', 'instances'],
      ['node-packs.json', 'nodePacks'],
      ['model-manifest.json', 'models'],
      ['workflows.json', 'workflows'],
      ['remote-instances.json', 'remotes'],
      ['node-snapshots.json', 'snapshots']
    ]
    for (const [file, key] of listEntries) {
      const val = parseFile(file)
      if (val === undefined) continue
      if (Array.isArray(val)) {
        lists[key] = val
        counts[key] = val.length
      } else {
        parseErrors.push(`${file}: expected array`)
      }
    }

    const roots = restoreRoots()
    const invalidPaths: string[] = []

    // Instance paths decide where the app runs commands and writes files. An
    // unknown root is refused rather than trusted (WP1).
    const keptInstances: Array<Record<string, unknown>> = []
    for (const inst of (lists.instances || []) as Array<Record<string, unknown>>) {
      const p = String(inst.path || '')
      if (!p) {
        // A path-less record cannot be launched; drop it instead of aborting the
        // whole restore (old hand-made backups may contain such rows).
        warnings.push(`instance ${String(inst.name || inst.id || '?')}: no path, skipped`)
        continue
      }
      if (!matchRoot(p, roots)) {
        invalidPaths.push(`instance ${String(inst.name || inst.id || '?')}: ${p}`)
        continue
      }
      // port/listen are interpolated into URLs later (`http://host:port`).
      if (inst.port !== undefined) {
        const port = Number(inst.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          warnings.push(`instance ${String(inst.name || inst.id || '?')}: invalid port, skipped`)
          continue
        }
        inst.port = port
      }
      if (inst.listen !== undefined) {
        const listen = String(inst.listen || '')
        if (!listen || /[;@\s\\/]/.test(listen)) {
          warnings.push(
            `instance ${String(inst.name || inst.id || '?')}: invalid listen host, skipped`
          )
          continue
        }
      }
      keptInstances.push(inst)
    }
    if (lists.instances) lists.instances = keptInstances
    // Remote records carry Bearer keys and internal URLs. Validate the URL and
    // never overwrite a key this machine cannot decrypt (keychain moved).
    if (lists.remotes) {
      const lockedIds = new Set(
        listRemotes()
          .filter((r) => r.apiKeyLocked)
          .map((r) => r.id)
      )
      const kept: Array<Record<string, unknown>> = []
      for (const r of lists.remotes as Array<Record<string, unknown>>) {
        const id = String(r.id || '')
        const baseUrl = String(r.baseUrl || '')
        if (!id || !baseUrl || !/^https?:\/\//i.test(baseUrl) || !isSafeExternalUrl(baseUrl)) {
          warnings.push(`remote ${id || '?'}: invalid base URL, skipped`)
          continue
        }
        if (lockedIds.has(id)) {
          warnings.push(`remote ${id}: API key is locked on this machine — kept local record`)
          continue
        }
        kept.push(r)
      }
      lists.remotes = kept
    }
    // Model paths feed delete/move/download operations — same containment.
    for (const m of (lists.models || []) as Array<Record<string, unknown>>) {
      const p = String(m.path || '')
      if (!p) continue
      if (!matchRoot(p, roots)) invalidPaths.push(`model ${String(m.name || m.id || '?')}: ${p}`)
    }

    // Workflow files: only workflow directories are writable (0.1.18
    // regression — the instance root itself must never be a restore target).
    const libraryRoot = workflowLibraryDir()
    const workflowRoots = workflowRestoreRoots()
    const files: PlanFile[] = []
    const seen = new Set<string>()
    for (const wf of (lists.workflows || []) as Array<Record<string, unknown>>) {
      const wfId = String(wf.id || '')
      if (!wfId || seen.has(wfId)) continue
      seen.add(wfId)
      const rawPath = String(wf.path || '')
      if (!rawPath) continue
      const { target, remapped } = workflowTargetFor(rawPath, wfId, workflowRoots, libraryRoot)
      const name = basename(target)
      if (remapped) {
        warnings.push(`workflow ${wfId}: path remapped to ${target}`)
      }
      const srcDir = join(dir, 'workflow-files', sanitizeId(wfId))
      let source: string | undefined
      let missing = false
      if (existsSync(srcDir)) {
        const entries = readdirSync(srcDir)
        if (entries.length) source = join(srcDir, entries[0])
      }
      if (!source) missing = true
      files.push({ id: wfId, name, target, remapped, missing, source })
      wf.path = target
    }
    counts.workflowFiles = files.filter((f) => !f.missing).length
    counts.workflows = (lists.workflows || []).length

    let settingsChanged: string[] = []
    if (settings) {
      try {
        settingsChanged = changedSettingKeys(settings, loadSettings())
      } catch {
        settingsChanged = []
      }
    }

    let name = ''
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8')) as { name?: string }
      name = String(raw?.name || '')
    } catch {
      /* manifest is optional for hand-made backups */
    }

    return {
      id: sanitizeId(id),
      name,
      settings,
      lists,
      files,
      invalidPaths,
      warnings,
      parseErrors,
      settingsChanged,
      counts
    }
  }

  delete(id: string): boolean {
    const dir = resolveBackupDir(id)
    try {
      if (existsSync(dir) && isPathInside(dir, backupDir())) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
    return deleteBackup(sanitizeId(id))
  }

  openFolder(id: string): string {
    return resolveBackupDir(id)
  }
}

export const backupService = new BackupService()
