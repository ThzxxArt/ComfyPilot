import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  unlinkSync
} from 'fs'
import { join, extname, basename, dirname } from 'path'
import { createHash } from 'crypto'
import type { WorkflowRecord, WorkflowOrigin, ComfyInstanceConfig } from '@shared/types'
import {
  loadSettings,
  upsertWorkflow,
  listWorkflows,
  updateWorkflow,
  deleteWorkflow as dbDeleteWorkflow,
  loadInstanceConfigs,
  workflowLibraryDir
} from './db'
import { ComfyApiClient } from './comfyApi'
import { assertSafeRelativeFilename, isPathInside } from './security'

// ---------- PNG metadata ----------

export function extractPngTextMeta(buf: Buffer): Record<string, unknown> {
  // PNG tEXt chunks: length(4) type(4) data crc(4)
  const meta: Record<string, unknown> = {}
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A — refuse non-PNG buffers.
  if (buf.length < 8 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    return meta
  }
  try {
    let offset = 8 // skip signature
    while (offset + 8 < buf.length) {
      const len = buf.readUInt32BE(offset)
      const type = buf.toString('ascii', offset + 4, offset + 8)
      const dataStart = offset + 8
      const dataEnd = dataStart + len
      if (type === 'tEXt') {
        const data = buf.toString('utf-8', dataStart, dataEnd)
        const nul = data.indexOf('\0')
        if (nul > 0) {
          meta[data.slice(0, nul)] = data.slice(nul + 1)
        }
      } else if (type === 'iTXt') {
        // keyword\0 flag method lang\0 transkey\0 text
        const data = buf.subarray(dataStart, dataEnd)
        const keyEnd = data.indexOf(0)
        if (keyEnd > 0) {
          const key = data.toString('utf-8', 0, keyEnd)
          let p = keyEnd + 3 // NUL + compression flag + compression method
          const langEnd = data.indexOf(0, p)
          if (langEnd >= 0) {
            p = langEnd + 1
            const transEnd = data.indexOf(0, p)
            if (transEnd >= 0) {
              meta[key] = data.toString('utf-8', transEnd + 1)
            }
          }
        }
      }
      if (type === 'IEND') break
      offset += 12 + len
    }
  } catch {
    /* ignore */
  }
  return meta
}

function parseWorkflowJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------- Analyze ----------

interface ParsedWorkflow {
  nodeCount: number
  description?: string
  missingNodes: string[]
  version: string
  seed?: number
  modelUsed?: string
  params: Record<string, unknown>
  /** API/UI graph payload extracted from JSON or PNG, when available. */
  graph: Record<string, unknown> | null
}

function analyzeUiOrApiGraph(parsed: Record<string, unknown>): ParsedWorkflow {
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
  const nodeCount = nodes.length
  const description = typeof parsed.name === 'string' ? parsed.name : undefined
  const version = String(parsed.version || '1.0')
  const missingNodes = (nodes as Array<{ type?: string }>)
    .filter((n) => typeof n?.type === 'string' && n.type.startsWith('Missing'))
    .map((n) => n.type as string)
  let seed: number | undefined
  let modelUsed: string | undefined
  for (const n of nodes as Array<Record<string, unknown>>) {
    const w = n.widgets_values
    if (Array.isArray(w)) {
      for (const v of w) {
        if (typeof v === 'number' && Number.isInteger(v) && v > 1 && v < 2 ** 32) {
          seed = seed ?? v
        }
      }
    }
    if (typeof n.title === 'string' && /model|checkpoint|unet/i.test(n.title)) {
      modelUsed = modelUsed || String(n.title)
    }
    // CheckpointLoaderSimple widgets_values[0] is the ckpt filename
    if (n.type === 'CheckpointLoaderSimple' && Array.isArray(w) && typeof w[0] === 'string') {
      modelUsed = modelUsed || String(w[0])
    }
    if (n.type === 'UNETLoader' && Array.isArray(w) && typeof w[0] === 'string') {
      modelUsed = modelUsed || String(w[0])
    }
  }
  return {
    nodeCount,
    description,
    missingNodes,
    version,
    seed,
    modelUsed,
    params: {
      nodeTypes: [...new Set((nodes as Array<{ type?: string }>).map((n) => n.type))].slice(0, 50)
    },
    graph: parsed
  }
}

function analyzeApiPrompt(prompt: Record<string, unknown>): ParsedWorkflow {
  const entries = Object.entries(prompt)
  let seed: number | undefined
  let modelUsed: string | undefined
  const missingNodes: string[] = []
  for (const [, node] of entries) {
    const n = node as { class_type?: string; inputs?: Record<string, unknown> }
    if (!n || typeof n !== 'object') continue
    const inputs = n.inputs || {}
    if (typeof inputs.seed === 'number' && seed == null) seed = inputs.seed
    if (typeof inputs.noise_seed === 'number' && seed == null) seed = inputs.noise_seed
    const ckpt = inputs.ckpt_name || inputs.unet_name || inputs.model_name
    if (typeof ckpt === 'string' && !modelUsed) modelUsed = ckpt
  }
  return {
    nodeCount: entries.length,
    missingNodes,
    version: '1.0',
    seed,
    modelUsed,
    params: {
      promptKeys: entries.map(([k]) => k).slice(0, 30),
      classTypes: [
        ...new Set(
          entries.map(([, v]) => (v as { class_type?: string })?.class_type).filter(Boolean)
        )
      ].slice(0, 50)
    },
    graph: prompt
  }
}

function analyzeParsedGraph(parsed: Record<string, unknown> | null): ParsedWorkflow {
  if (!parsed) {
    return { nodeCount: 0, missingNodes: [], version: '1.0', params: {}, graph: null }
  }
  if (Array.isArray(parsed.nodes)) return analyzeUiOrApiGraph(parsed)
  // API prompt form: { "1": { class_type, inputs } }
  const values = Object.values(parsed)
  const looksLikeApi =
    values.length > 0 &&
    values.every((v) => {
      const n = v as { class_type?: string; inputs?: unknown }
      return n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs != null
    })
  if (looksLikeApi) return analyzeApiPrompt(parsed)
  if (parsed.prompt && typeof parsed.prompt === 'object') {
    return analyzeParsedGraph(parsed.prompt as Record<string, unknown>)
  }
  if (parsed.workflow && typeof parsed.workflow === 'object') {
    return analyzeParsedGraph(parsed.workflow as Record<string, unknown>)
  }
  return { nodeCount: 0, missingNodes: [], version: '1.0', params: {}, graph: parsed }
}

/**
 * Reject anything that is not a recognisable ComfyUI workflow.
 * Accepts: UI graph `{nodes:[...]}`, API prompt `{id:{class_type,inputs}}`,
 * or the common wrappers `{workflow:...}` / `{prompt:...}`.
 */
function assertComfyWorkflow(graph: Record<string, unknown>): void {
  const check = (g: Record<string, unknown>): boolean => {
    if (Array.isArray(g.nodes)) return true
    const values = Object.values(g)
    if (
      values.length > 0 &&
      values.every((v) => {
        const n = v as { class_type?: string; inputs?: unknown }
        return n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs != null
      })
    ) {
      return true
    }
    if (g.workflow && typeof g.workflow === 'object' && check(g.workflow as Record<string, unknown>)) {
      return true
    }
    if (g.prompt && typeof g.prompt === 'object' && check(g.prompt as Record<string, unknown>)) {
      return true
    }
    return false
  }
  if (!check(graph)) {
    throw new Error(
      'Not a ComfyUI workflow: expected a UI graph {nodes:[…]} or an API prompt {id:{class_type,inputs}}'
    )
  }
}

function analyzeFile(full: string, ext: string): ParsedWorkflow {
  if (ext === '.json') {
    const parsed = parseWorkflowJson(readFileSync(full, 'utf-8'))
    return analyzeParsedGraph(parsed)
  }
  // PNG: extract meta, prefer embedded workflow (UI) then prompt (API)
  const buf = readFileSync(full)
  const textMeta = extractPngTextMeta(buf)
  let graph: Record<string, unknown> | null = null
  if (textMeta.workflow) {
    graph = parseWorkflowJson(String(textMeta.workflow))
  }
  if (!graph && textMeta.prompt) {
    graph = parseWorkflowJson(String(textMeta.prompt))
  }
  const base = analyzeParsedGraph(graph)
  const params: Record<string, unknown> = {
    ...base.params,
    pngMeta: Object.keys(textMeta)
  }
  let seed = base.seed
  if (seed == null && textMeta.seed) {
    const n = Number(textMeta.seed)
    if (Number.isFinite(n)) seed = n
  }
  let modelUsed = base.modelUsed
  if (!modelUsed && textMeta.model) modelUsed = String(textMeta.model)
  return {
    ...base,
    seed,
    modelUsed,
    params,
    graph
  }
}

function recordIdFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

// ---------- Service ----------

export class WorkflowService {
  /** ComfyPilot library root (settings override or userData/data/workflows). */
  libraryRoot(): string {
    return workflowLibraryDir()
  }

  /**
   * Scan roots:
   *  1. ComfyPilot workflow library (always — this is where imports land)
   *  2. Each instance's `user/default/workflows`
   *  3. settings.defaultInstancePath workflows
   *  4. process.cwd()/workflows (dev convenience)
   *  5. optional explicit `dir`
   *
   * Returns the UNION of scanned files and DB records. DB-only rows whose file
   * vanished are marked `missing` so the UI can show/repair them instead of
   * silently dropping the user's import.
   */
  list(opts?: { includeMissing?: boolean }): WorkflowRecord[] {
    const settings = loadSettings()
    const instances = loadInstanceConfigs()
    const library = this.libraryRoot()
    const roots: Array<{ root: string; origin: WorkflowOrigin }> = [
      { root: library, origin: 'library' },
      ...instances.map((i) => ({
        root: join(i.path, 'user', 'default', 'workflows'),
        origin: 'instance' as WorkflowOrigin
      })),
      ...(settings.defaultInstancePath
        ? [
            {
              root: join(settings.defaultInstancePath, 'user', 'default', 'workflows'),
              origin: 'instance' as WorkflowOrigin
            }
          ]
        : []),
      { root: join(process.cwd(), 'workflows'), origin: 'external' as WorkflowOrigin }
    ]

    const seen = new Set<string>()
    const scanned: WorkflowRecord[] = []
    for (const { root, origin } of roots) {
      if (!root || !existsSync(root)) continue
      this.walk(root, scanned, seen, 0, origin)
    }

    // Preserve user metadata (tags / favorite / description / importedAt) across rescans.
    const dbById = new Map(listWorkflows().map((w) => [w.id, w]))
    const dbByPath = new Map(listWorkflows().map((w) => [w.path, w]))

    const out: WorkflowRecord[] = []
    const scannedPaths = new Set<string>()
    for (const rec of scanned) {
      scannedPaths.add(rec.path)
      const prev = dbById.get(rec.id) || dbByPath.get(rec.path)
      const merged: WorkflowRecord = {
        ...rec,
        tags: prev?.tags?.length ? prev.tags : rec.tags,
        favorite: prev?.favorite ?? rec.favorite,
        description: prev?.description ?? rec.description,
        importedAt: prev?.importedAt ?? rec.importedAt,
        sourcePath: prev?.sourcePath ?? rec.sourcePath,
        // Fresh analysis wins for derived keys; import-time markers
        // (extractedFrom etc.) must survive every rescan.
        params: { ...(prev?.params || {}), ...rec.params },
        missing: false
      }
      upsertWorkflow(merged)
      out.push(merged)
    }

    // DB rows that no longer resolve to a file
    for (const prev of listWorkflows()) {
      if (scannedPaths.has(prev.path)) continue
      if (seen.has(prev.path)) continue
      const exists = existsSync(prev.path)
      if (!exists) {
        const missingRec: WorkflowRecord = { ...prev, missing: true }
        upsertWorkflow(missingRec)
        if (opts?.includeMissing !== false) out.push(missingRec)
        continue
      }
      // File exists but outside scan roots (user-imported external path) — keep visible.
      const recovered = this.buildRecord(prev.path, prev.origin || 'external', {
        ...prev
      })
      upsertWorkflow(recovered)
      out.push(recovered)
    }

    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private walk(
    dir: string,
    out: WorkflowRecord[],
    seen: Set<string>,
    depth: number,
    origin: WorkflowOrigin
  ): void {
    if (depth > 5) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          this.walk(full, out, seen, depth + 1, origin)
          continue
        }
        const ext = extname(name).toLowerCase()
        if (!['.json', '.png'].includes(ext)) continue
        if (seen.has(full)) continue
        seen.add(full)
        out.push(this.buildRecord(full, origin))
      } catch {
        /* skip */
      }
    }
  }

  private buildRecord(
    full: string,
    origin: WorkflowOrigin,
    preserve?: Partial<WorkflowRecord>
  ): WorkflowRecord {
    const st = statSync(full)
    const ext = extname(full).toLowerCase()
    const analyzed = analyzeFile(full, ext)
    const id = recordIdFor(full)
    return {
      id,
      name: preserve?.name || basename(full, ext),
      path: full,
      format: ext === '.png' ? 'png' : 'json',
      nodeCount: analyzed.nodeCount,
      tags: preserve?.tags || [],
      description: analyzed.description ?? preserve?.description,
      updatedAt: st.mtimeMs,
      missingNodes: analyzed.missingNodes,
      version: analyzed.version,
      seed: analyzed.seed ?? preserve?.seed,
      modelUsed: analyzed.modelUsed ?? preserve?.modelUsed,
      // Keep import-time markers (extractedFrom etc.) across rescans.
      params: { ...(preserve?.params || {}), ...analyzed.params },
      origin,
      sourcePath: preserve?.sourcePath,
      favorite: preserve?.favorite,
      importedAt: preserve?.importedAt,
      missing: false
    }
  }

  /** Instance workflows folder — the place ComfyUI actually reads. */
  instanceWorkflowsDir(instanceId?: string): string {
    const instances = loadInstanceConfigs()
    const inst =
      instances.find((i) => i.id === instanceId) ||
      instances.find((i) => i.id === (loadSettings() as { activeInstance?: string }).activeInstance) ||
      instances[0]
    if (!inst) throw new Error('No instance configured')
    return join(inst.path, 'user', 'default', 'workflows')
  }

  /**
   * True import: materialise EXACTLY ONE `.json` into the TARGET INSTANCE's
   * `user/default/workflows` folder — the directory ComfyUI actually loads,
   * so the workflow shows up in Frontend immediately.
   * - `.json` source → validated then written
   * - `.png` source  → embedded workflow/prompt extracted to `.json`
   *   (the PNG itself is NOT copied — one import = one JSON artifact)
   *
   * Anything that is not a recognisable ComfyUI workflow is REJECTED with a
   * clear reason. There is no silent "empty card" import.
   */
  async importFile(path: string, instanceId?: string): Promise<WorkflowRecord> {
    if (!existsSync(path)) throw new Error(`Workflow file not found: ${path}`)
    const st = statSync(path)
    if (!st.isFile()) throw new Error(`Not a file: ${path}`)

    const ext = extname(path).toLowerCase()
    if (!['.json', '.png'].includes(ext)) {
      throw new Error(`Unsupported workflow type: ${ext || '(none)'} — only .json / .png`)
    }

    // ---- parse + validate BEFORE touching disk ----
    let graph: Record<string, unknown>
    if (ext === '.png') {
      const meta = extractPngTextMeta(readFileSync(path))
      const raw = String(meta.workflow || meta.prompt || '')
      const parsed = raw ? parseWorkflowJson(raw) : null
      if (!parsed) {
        throw new Error(
          'Not a ComfyUI workflow: this PNG has no embedded workflow/prompt metadata'
        )
      }
      graph = parsed
    } else {
      const parsed = parseWorkflowJson(readFileSync(path, 'utf-8'))
      if (!parsed) {
        throw new Error('Not a ComfyUI workflow: file is not valid JSON')
      }
      graph = parsed
    }
    // Throws with a descriptive message when the shape is wrong.
    assertComfyWorkflow(graph)

    // ---- land exactly one .json in the instance workflows folder ----
    const targetDir = this.instanceWorkflowsDir(instanceId)
    mkdirSync(targetDir, { recursive: true })
    const safeBase = assertSafeRelativeFilename(basename(path, ext)).slice(0, 120)
    let dest = join(targetDir, `${safeBase}.json`)
    let n = 1
    while (existsSync(dest) && !resolveSame(dest, path)) {
      dest = join(targetDir, `${safeBase}-${n}.json`)
      n += 1
      if (n > 200) throw new Error('Too many name collisions in the instance workflows folder')
    }
    writeFileSync(dest, JSON.stringify(graph, null, 2), 'utf-8')

    const rec = this.buildRecord(dest, 'instance', {
      sourcePath: path,
      importedAt: Date.now(),
      name: safeBase,
      tags: [],
      favorite: false,
      params: ext === '.png' ? { extractedFrom: path } : {}
    })
    upsertWorkflow(rec)
    return rec
  }

  async importMany(paths: string[], instanceId?: string): Promise<WorkflowRecord[]> {
    const out: WorkflowRecord[] = []
    const errors: string[] = []
    for (const p of paths) {
      try {
        out.push(await this.importFile(p, instanceId))
      } catch (e) {
        errors.push(`${basename(p)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!out.length && errors.length) {
      throw new Error(errors.join('; '))
    }
    return out
  }

  async tag(id: string, tags: string[]): Promise<WorkflowRecord> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id || w.path === id)
    if (!rec) throw new Error('Workflow not found')
    const next = { ...rec, tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))] }
    upsertWorkflow(next)
    return next
  }

  async favorite(id: string, favorite: boolean): Promise<WorkflowRecord> {
    const updated = updateWorkflow(id, { favorite })
    if (!updated) throw new Error('Workflow not found')
    return updated
  }

  async rename(id: string, name: string): Promise<WorkflowRecord> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    const safe = assertSafeRelativeFilename(name)
    const ext = extname(rec.path)
    const dir = dirname(rec.path)
    const dest = join(dir, `${safe}${ext}`)
    if (dest !== rec.path) {
      if (existsSync(dest)) throw new Error('Target name already exists')
      if (existsSync(rec.path)) renameSync(rec.path, dest)
    }
    const next: WorkflowRecord = {
      ...rec,
      id: recordIdFor(dest),
      name: safe,
      path: dest,
      updatedAt: Date.now()
    }
    // Drop the old id row so list() does not resurrect it as missing.
    if (next.id !== rec.id) dbDeleteWorkflow(rec.id)
    upsertWorkflow(next)
    return next
  }

  /**
   * Delete a workflow record.
   *
   * - library  → always deletes the file (ComfyPilot owns it)
   * - instance → deletes the source file too when `deleteSource` is true
   *              (default true — the user asked to support this)
   * - external → NEVER touches the file, unregister only
   *
   * A PNG import that produced a sibling .json is cleaned up as a pair.
   */
  async remove(id: string, opts?: { deleteSource?: boolean }): Promise<boolean> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) return false
    const library = this.libraryRoot()
    const isExternal = rec.origin === 'external'
    // External files are never ours to delete.
    const deleteSource = isExternal ? false : opts?.deleteSource !== false

    if (deleteSource && rec.path) {
      const inLibrary = rec.origin === 'library' && isPathInside(rec.path, library)
      const inInstance = rec.origin === 'instance'
      if (inLibrary || inInstance) {
        try {
          if (existsSync(rec.path)) unlinkSync(rec.path)
        } catch {
          /* keep going — DB row still removed */
        }
        // Only clean a true sibling INSIDE the same folder (legacy PNG↔JSON
        // pairs). `params.extractedFrom` points at the user's ORIGINAL source
        // and must never be deleted.
        const sibling = this.siblingPath(rec)
        if (sibling && dirname(sibling) === dirname(rec.path)) {
          const sibRec = all.find((w) => w.path === sibling)
          try {
            if (existsSync(sibling)) unlinkSync(sibling)
          } catch {
            /* ignore */
          }
          if (sibRec) dbDeleteWorkflow(sibRec.id)
        }
      }
    }
    return dbDeleteWorkflow(id)
  }

  /**
   * Same-folder `.json`/`.png` counterpart of a legacy pair.
   * NEVER returns `params.extractedFrom` — that is the original source file
   * outside the target folder and deleting it would destroy user data.
   */
  private siblingPath(rec: WorkflowRecord): string | null {
    const p = rec.path
    if (/\.png$/i.test(p)) {
      const j = p.replace(/\.png$/i, '.json')
      return existsSync(j) ? j : null
    }
    if (/\.json$/i.test(p)) {
      const png = p.replace(/\.json$/i, '.png')
      return existsSync(png) ? png : null
    }
    return null
  }

  /** Zip the workflow (json preferred, else png) + optional notes into destDir. */
  async exportZip(id: string, destDir?: string): Promise<{ path: string }> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    if (!existsSync(rec.path)) throw new Error('Workflow file missing on disk')

    const targetDir = destDir || this.libraryRoot()
    mkdirSync(targetDir, { recursive: true })
    const zipPath = join(targetDir, `${assertSafeRelativeFilename(rec.name)}.zip`)

    // Prefer a real JSON payload for portability.
    let payloadPath = rec.path
    let payloadName = basename(rec.path)
    if (rec.format === 'png') {
      const meta = extractPngTextMeta(readFileSync(rec.path))
      const raw = String(meta.workflow || meta.prompt || '')
      const parsed = raw ? parseWorkflowJson(raw) : null
      if (parsed) {
        const tmp = join(targetDir, `${assertSafeRelativeFilename(rec.name)}.json`)
        writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf-8')
        payloadPath = tmp
        payloadName = basename(tmp)
        // The temp json is also the export payload — zip it then leave it
        // (user-visible export folder). Fine for a share bundle.
      }
    }

    const { createWorkflowZip } = await import('./zipWrite')
    await createWorkflowZip(zipPath, [
      { path: payloadPath, name: payloadName },
      {
        name: 'README.txt',
        content:
          `ComfyPilot workflow export\n` +
          `Name: ${rec.name}\n` +
          `Version: ${rec.version}\n` +
          `Nodes: ${rec.nodeCount}\n` +
          `Tags: ${(rec.tags || []).join(', ') || '(none)'}\n` +
          (rec.sourcePath ? `Source: ${rec.sourcePath}\n` : '')
      }
    ])
    return { path: zipPath }
  }

  /** Copy a workflow into a ComfyUI instance's user/default/workflows. */
  async copyToInstance(id: string, instanceId: string): Promise<{ path: string }> {
    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === instanceId) || instances[0]
    if (!inst) throw new Error('No instance configured')
    return this.copyToInstancePath(id, inst)
  }

  private copyToInstancePath(id: string, inst: ComfyInstanceConfig): { path: string } {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    if (!existsSync(rec.path)) throw new Error('Workflow file missing on disk')

    const destDir = join(inst.path, 'user', 'default', 'workflows')
    mkdirSync(destDir, { recursive: true })
    const ext = extname(rec.path)
    const safe = assertSafeRelativeFilename(rec.name)
    let dest = join(destDir, `${safe}${ext}`)
    let n = 1
    while (existsSync(dest) && !resolveSame(dest, rec.path)) {
      dest = join(destDir, `${safe}-${n}${ext}`)
      n += 1
      if (n > 200) throw new Error('Too many name collisions in instance workflows')
    }
    if (!resolveSame(dest, rec.path)) copyFileSync(rec.path, dest)
    return { path: dest }
  }

  /**
   * Copy the workflow into the target instance's library and report the
   * Frontend URL. Does NOT open anything — the IPC layer starts the instance
   * (if needed) and opens embed/browser so a stopped instance never yields a
   * dead "opened Frontend" toast.
   */
  async prepareFrontend(
    id: string,
    instanceId?: string
  ): Promise<{ instanceId: string; instanceName: string; url: string; copiedPath: string }> {
    const instances = loadInstanceConfigs()
    const inst =
      instances.find((i) => i.id === instanceId) ||
      instances.find((i) => i.id === (loadSettings() as { activeInstance?: string }).activeInstance) ||
      instances[0]
    if (!inst) throw new Error('No instance configured')

    const copied = this.copyToInstancePath(id, inst)
    const host =
      inst.listen === '0.0.0.0' || inst.listen === '::' || inst.listen === '[::]'
        ? '127.0.0.1'
        : inst.listen
    const url = `http://${host}:${inst.port}`
    return {
      instanceId: inst.id,
      instanceName: inst.name,
      url,
      copiedPath: copied.path
    }
  }

  async reveal(id: string): Promise<boolean> {
    const rec = listWorkflows().find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    const { shell } = await import('electron')
    shell.showItemInFolder(rec.path)
    return true
  }

  libraryInfo(instanceId?: string): {
    root: string
    instanceName: string
    count: number
    missing: number
  } {
    const instances = loadInstanceConfigs()
    const inst =
      instances.find((i) => i.id === instanceId) ||
      instances.find((i) => i.id === (loadSettings() as { activeInstance?: string }).activeInstance) ||
      instances[0]
    const root = inst
      ? join(inst.path, 'user', 'default', 'workflows')
      : this.libraryRoot()
    const all = this.list({ includeMissing: true })
    return {
      root,
      instanceName: inst?.name || '',
      count: all.filter((w) => !w.missing).length,
      missing: all.filter((w) => w.missing).length
    }
  }

  async queue(opts: {
    workflowPath: string
    instanceId: string
    seed?: number
  }): Promise<string | null> {
    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === opts.instanceId) || instances[0]
    if (!inst) throw new Error('No instance configured')
    // Same host normalisation as p1p2.instanceUrl — IPv6 listeners included.
    const host =
      inst.listen === '0.0.0.0' || inst.listen === '::' || inst.listen === '[::]'
        ? '127.0.0.1'
        : inst.listen
    const url = `http://${host}:${inst.port}`

    let rawJson: unknown = null
    const ext = extname(opts.workflowPath).toLowerCase()
    if (ext === '.png') {
      const meta = extractPngTextMeta(readFileSync(opts.workflowPath))
      if (meta.prompt) {
        try {
          rawJson = JSON.parse(String(meta.prompt))
        } catch {
          rawJson = null
        }
      }
      if (!rawJson && meta.workflow) {
        try {
          rawJson = JSON.parse(String(meta.workflow))
        } catch {
          rawJson = null
        }
      }
    } else {
      rawJson = parseWorkflowJson(readFileSync(opts.workflowPath, 'utf-8'))
    }
    if (!rawJson) throw new Error('Cannot parse workflow prompt')

    const { toApiPrompt, applySeedToPrompt } = await import('./workflowConvert')
    let prompt = toApiPrompt(rawJson)
    if (opts.seed != null) prompt = applySeedToPrompt(prompt, opts.seed)

    const client = new ComfyApiClient(url)
    const { COMFY_CLIENT_ID } = await import('./comfyApi')
    // queuePrompt throws with ComfyUI's error body on rejection — propagate it.
    const promptId = await client.queuePrompt(prompt, COMFY_CLIENT_ID)
    if (!promptId) {
      throw new Error('ComfyUI accepted the prompt but returned no prompt_id')
    }
    return promptId
  }

  async parsePngMeta(path: string): Promise<Record<string, unknown> | null> {
    if (!existsSync(path)) return null
    // PNG only — never slurp videos/audio into memory looking for tEXt chunks.
    if (!/\.png$/i.test(path)) return null
    const { statSync: stFn, openSync, readSync, closeSync } = await import('fs')
    const st = stFn(path)
    if (!st.size) return null
    // tEXt/iTXt live near the head; cap how much we read (full file only when small).
    const cap = Math.min(st.size, 8 * 1024 * 1024)
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(cap)
      readSync(fd, buf, 0, cap, 0)
      return extractPngTextMeta(buf)
    } finally {
      closeSync(fd)
    }
  }

  listCached(): WorkflowRecord[] {
    return listWorkflows()
  }
}

function resolveSame(a: string, b: string): boolean {
  try {
    // Only Windows and macOS default to case-insensitive paths.
    const fold = process.platform === 'win32' || process.platform === 'darwin'
    const key = (p: string) => (fold ? p.toLowerCase() : p)
    return key(a) === key(b)
  } catch {
    return false
  }
}

export const workflowService = new WorkflowService()
