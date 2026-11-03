/**
 * IssueCenter single source of truth (0.2.0).
 *
 * Aggregates startup import failures, node-load report rows, dependency-audit
 * results, doctor failures and recorded execution failures into persisted,
 * de-duplicated issues. Every issue carries at least one executable action.
 *
 * Lifecycle:
 * - fingerprint = instance + source + pack + module + pack mtime
 * - an ignored issue stays ignored across restarts while its fingerprint is
 *   unchanged; changing the pack (update/reinstall) changes mtime and reopens
 *   a new issue automatically.
 * - a source that failed to run never resolves its previous issues.
 */
import { existsSync, statSync } from 'fs'
import type { AppIssue, AppIssueAction, AppIssueKind } from '@shared/types'
import { resolvePipAlias } from '@shared/pipAliases'
import { recipeForModule, recipeSupportsPlatform } from '@shared/pipRecipes'
import { loadInstanceConfigs, listIssues, replaceIssues } from './db'
import { instanceService } from './instance'
import { nodePackService } from './nodePack'

const TRANSIENT_RE = /(\.trash-|\.bak-|\.cp-old-|^\._)/
const TRASH_REMINDER_MS = 7 * 24 * 60 * 60 * 1000

function fingerprint(parts: Array<string | number | undefined>): string {
  return parts.map((p) => String(p ?? '').replace(/[|]/g, '_')).join('|')
}

function nodeLink(instanceId: string, focus: string, source: string): string {
  const q = new URLSearchParams({ instanceId, focus, source })
  return `/nodes?${q.toString()}`
}

function isTransientPack(pack: string): boolean {
  return TRANSIENT_RE.test(String(pack || ''))
}

function actionsFor(
  kind: AppIssueKind,
  instanceId: string,
  pack: string,
  module: string | undefined,
  source: string
): AppIssueAction[] {
  const actions: AppIssueAction[] = [
    {
      id: 'open-nodes',
      labelKey: 'issues.actionOpenNodes',
      kind: 'navigate',
      target: nodeLink(instanceId, pack, source)
    }
  ]
  if (kind === 'deps' || kind === 'startup' || kind === 'node-load' || kind === 'exec') {
    actions.push({
      id: 'run-audit',
      labelKey: 'issues.actionAudit',
      kind: 'navigate',
      target: nodeLink(instanceId, pack, 'deps')
    })
  }
  if (module && (kind === 'startup' || kind === 'node-load' || kind === 'exec')) {
    actions.push({
      id: 'install-module',
      labelKey: 'issues.actionInstallModule',
      kind: 'ipc',
      target: 'issue.installModule'
    })
  }
  if (isTransientPack(pack)) {
    actions.push({
      id: 'clean-leftover',
      labelKey: 'issues.actionCleanLeftover',
      kind: 'ipc',
      target: 'issue.cleanLeftover'
    })
    actions.push({
      id: 'recovery',
      labelKey: 'issues.actionRecovery',
      kind: 'navigate',
      target: `${nodeLink(instanceId, pack, 'recovery')}&showRecovery=1`
    })
  }
  return actions
}

function makeIssue(input: {
  fingerprint: string
  kind: AppIssueKind
  instanceId: string
  pack?: string
  module?: string
  severity: AppIssue['severity']
  title: string
  detail: string
}): AppIssue {
  const now = Date.now()
  return {
    id: input.fingerprint,
    ...input,
    actions: actionsFor(input.kind, input.instanceId, input.pack || '', input.module, input.kind),
    status: 'open',
    firstSeen: now,
    lastSeen: now,
    updatedAt: now
  }
}

function mergeIssues(fresh: AppIssue[], resolvableKinds: Set<AppIssueKind>): AppIssue[] {
  const now = Date.now()
  const old = new Map(listIssues().map((i) => [i.fingerprint, i]))
  const seen = new Set<string>()
  const merged: AppIssue[] = []
  for (const issue of fresh) {
    seen.add(issue.fingerprint)
    const prev = old.get(issue.fingerprint)
    if (!prev) {
      merged.push(issue)
      continue
    }
    // Same fingerprint: keep the user's lifecycle state. A resolved/ignored
    // issue only reopens when its fingerprint changes (e.g. pack mtime).
    merged.push({
      ...issue,
      firstSeen: prev.firstSeen,
      status: prev.status === 'resolved' || prev.status === 'acknowledged' ? 'open' : prev.status,
      updatedAt: prev.status === 'ignored' ? prev.updatedAt : now
    })
  }
  // Problems that vanished from the latest scan become resolved, unless the
  // user explicitly ignored them or the source could not run.
  for (const [fp, prev] of old) {
    if (seen.has(fp)) continue
    if (!resolvableKinds.has(prev.kind)) {
      merged.push(prev)
      continue
    }
    merged.push(
      prev.status === 'ignored'
        ? prev
        : { ...prev, status: 'resolved', lastSeen: now, updatedAt: now }
    )
  }
  replaceIssues(merged)
  return merged
}

function packMtime(
  packs: Array<{ name?: string; displayName?: string; path?: string }>,
  pack: string
): number {
  const wanted = String(pack || '').toLowerCase()
  if (!wanted) return 0
  const hit = packs.find((p) => {
    const names = [p.name, p.displayName].filter(Boolean).map((n) => String(n).toLowerCase())
    const path = String(p.path || '')
      .replace(/\\/g, '/')
      .toLowerCase()
    return names.includes(wanted) || path.endsWith(`/${wanted}`)
  })
  if (!hit?.path) return 0
  try {
    return existsSync(hit.path) ? statSync(hit.path).mtimeMs : 0
  } catch {
    return 0
  }
}

function packExists(
  packs: Array<{ name?: string; displayName?: string; path?: string }>,
  pack: string
): boolean {
  const wanted = String(pack || '').toLowerCase()
  if (!wanted) return true
  return packs.some((p) => {
    const names = [p.name, p.displayName].filter(Boolean).map((n) => String(n).toLowerCase())
    const path = String(p.path || '')
      .replace(/\\/g, '/')
      .toLowerCase()
    return names.includes(wanted) || path.endsWith(`/${wanted}`)
  })
}

export class IssueHubService {
  list(includeResolved = false): AppIssue[] {
    const all = listIssues()
    return all
      .filter((i) => includeResolved || (i.status !== 'resolved' && i.status !== 'ignored'))
      .sort((a, b) => {
        const rank = { error: 0, warning: 1, info: 2 } as const
        if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity]
        return b.lastSeen - a.lastSeen
      })
  }

  async scan(instanceId?: string): Promise<AppIssue[]> {
    const configs = loadInstanceConfigs().filter((c) => !instanceId || c.id === instanceId)
    if (instanceId && !configs.length) throw new Error(`Instance not found: ${instanceId}`)
    const fresh: AppIssue[] = []
    // A source that failed to run must NOT resolve its previous issues.
    const resolvable = new Set<AppIssueKind>(['startup', 'node-load', 'exec', 'deps', 'doctor'])
    for (const config of configs) {
      const id = config.id
      // Cross-check against the real custom_nodes listing. A pack that was
      // deleted must not keep an issue alive; a transient leftover is kept so
      // the recovery action remains reachable.
      let packs: Array<{ name?: string; displayName?: string; path?: string }> = []
      try {
        packs = nodePackService.list(id)
      } catch {
        packs = []
      }
      const packVisible = (pack: string): boolean =>
        isTransientPack(pack) || !pack || pack === 'unknown' || packExists(packs, pack)

      // Startup traceback issues.
      try {
        const startup = instanceService.analyzeStartupIssues(id)
        for (const issue of startup.issues) {
          if (!packVisible(issue.pack)) continue
          const fp = fingerprint([
            'startup',
            id,
            issue.pack,
            ...(issue.missingModules || []).slice().sort(),
            Math.round(packMtime(packs, issue.pack))
          ])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'startup',
              instanceId: id,
              pack: issue.pack,
              module: issue.missingModules[0],
              severity: issue.missingModules.length ? 'error' : 'warning',
              title: issue.missingModules.length
                ? `Missing dependency: ${issue.missingModules.join(', ')}`
                : issue.summary,
              detail: issue.summary
            })
          )
        }
      } catch {
        /* startup parsing is advisory */
      }

      // ComfyUI's own import-times block.
      try {
        const report = nodePackService.loadReport(id)
        for (const entry of report?.entries || []) {
          if (entry.ok) continue
          if (!packVisible(entry.folder)) continue
          const fp = fingerprint([
            'node-load',
            id,
            entry.folder,
            entry.modulePath,
            Math.round(packMtime(packs, entry.folder))
          ])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'node-load',
              instanceId: id,
              pack: entry.folder,
              severity: entry.prestartup ? 'warning' : 'error',
              title: `${entry.folder || 'Unknown pack'} failed to ${entry.prestartup ? 'run prestartup' : 'import'}`,
              detail: entry.error || 'Import failed'
            })
          )
        }
        for (const refusal of report?.policyRefused || []) {
          if (!packVisible(refusal.folder)) continue
          const fp = fingerprint([
            'policy',
            id,
            refusal.folder,
            refusal.reason,
            Math.round(packMtime(packs, refusal.folder))
          ])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'node-load',
              instanceId: id,
              pack: refusal.folder,
              severity: 'warning',
              title: `${refusal.folder} was blocked by policy`,
              detail: refusal.reason
            })
          )
        }
      } catch {
        /* report is advisory */
      }

      // Quarantined leftovers older than 7 days get a reminder; they are never
      // deleted automatically.
      try {
        const now = Date.now()
        for (const entry of nodePackService.scanRecovery(id)) {
          if (entry.kind !== 'trash') continue
          if (now - entry.mtimeMs < TRASH_REMINDER_MS) continue
          const fp = fingerprint(['recovery', id, entry.name, Math.round(entry.mtimeMs)])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'node-load',
              instanceId: id,
              pack: entry.name,
              severity: 'warning',
              title: `Quarantined leftover is older than 7 days: ${entry.name}`,
              detail: entry.path
            })
          )
        }
      } catch {
        /* recovery scan is advisory */
      }

      // Recorded execution failures (WS + log) from the diagnosis service.
      try {
        const { execDiagnosticsService } = await import('./execDiagnostics')
        for (const failure of execDiagnosticsService.list(id)) {
          const pack = failure.packFolder || ''
          if (!packVisible(pack)) continue
          const fp = fingerprint([
            'exec',
            id,
            pack || failure.nodeType || 'unknown',
            failure.missingModule || failure.errorType,
            Math.round(packMtime(packs, pack))
          ])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'exec',
              instanceId: id,
              pack,
              module: failure.missingModule,
              severity: 'error',
              title: failure.missingModule
                ? `Missing module: ${failure.missingModule}`
                : `Execution failed: ${failure.errorType || failure.nodeType || 'unknown'}`,
              detail: failure.message
            })
          )
        }
      } catch {
        /* exec diagnostics is advisory */
      }

      // Dependency audit is network/venv dependent; a failure is not an issue.
      try {
        const audit = await nodePackService.depsAudit(id)
        // A failed audit (pip missing / env mismatch) says nothing about
        // whether the old dependency issue was fixed.
        if (!audit.ok) resolvable.delete('deps')
        for (const pack of audit.packs || []) {
          if (!packVisible(pack.name)) continue
          const fp = fingerprint([
            'deps',
            id,
            pack.name,
            ...pack.missing.slice().sort(),
            ...pack.mismatched.map((m) => `${m.name}${m.required}`).sort(),
            Math.round(packMtime(packs, pack.name))
          ])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'deps',
              instanceId: id,
              pack: pack.name,
              severity: 'warning',
              title: `${pack.name}: ${pack.missing.length + pack.mismatched.length} dependency problem(s)`,
              detail: [
                ...pack.missing.map((m) => `missing ${m}`),
                ...pack.mismatched.map(
                  (m) => `${m.name} requires ${m.required}, installed ${m.installed}`
                )
              ].join('; ')
            })
          )
        }
      } catch {
        resolvable.delete('deps')
      }

      // Doctor findings are only included on an explicit scan (it can take a
      // while); keep the aggregate honest rather than guessing.
      try {
        const { doctorService } = await import('./doctor')
        const report = await doctorService.run(id)
        for (const check of report.checks || []) {
          if (check.severity !== 'fail' && check.severity !== 'warn') continue
          const fp = fingerprint(['doctor', id, check.id, check.detail])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'doctor',
              instanceId: id,
              severity: check.severity === 'fail' ? 'error' : 'warning',
              title: check.title,
              detail: check.suggestion || check.detail
            })
          )
        }
      } catch {
        resolvable.delete('doctor')
      }
    }
    mergeIssues(fresh, resolvable)
    return this.list()
  }

  dismiss(id: string): AppIssue | null {
    return this.setStatus(id, 'ignored')
  }

  restore(id: string): AppIssue | null {
    return this.setStatus(id, 'open')
  }

  resolve(id: string): AppIssue | null {
    return this.setStatus(id, 'resolved')
  }

  /** Install the module named by a startup/load/exec issue, then re-scan. */
  async installModule(id: string): Promise<{ ok: boolean; message: string }> {
    const issue = listIssues().find((i) => i.id === id)
    if (!issue) throw new Error('Issue not found')
    if (!issue.instanceId) throw new Error('This issue has no local instance')
    if (!issue.module) throw new Error('This issue has no missing module')
    const moduleName = String(issue.module).split('.')[0]
    const spec = resolvePipAlias(moduleName)
    // Some missing modules have a curated fix (triton-windows, the verified
    // SageAttention wheel, onnx). Plain `pip install triton` has no Windows
    // wheel, so the generic path would fail where the recipe succeeds.
    // Platform-gated recipes fall back to the generic spec elsewhere.
    const recipe = recipeForModule(moduleName)
    const useRecipe = recipe && recipeSupportsPlatform(recipe) ? recipe : undefined
    const { pipOpsService } = await import('./pipOps')
    const result = useRecipe
      ? await pipOpsService.installRecipe(issue.instanceId, useRecipe.id)
      : await pipOpsService.installSpec(issue.instanceId, spec)
    if (result.ok) {
      // Do not immediately re-scan the old boot log: it still contains the
      // pre-install traceback, which would make a successful fix look open
      // again. The next boot/scan is the honest verification point.
      this.setStatus(id, 'resolved')
    }
    const label = useRecipe ? `${useRecipe.id} recipe` : spec
    return {
      ok: result.ok,
      message: result.ok ? `Installed ${label}` : result.error || `Could not install ${label}`
    }
  }

  /** Delete one quarantined leftover referenced by an issue. */
  cleanLeftover(id: string): { ok: boolean; message: string } {
    const issue = listIssues().find((i) => i.id === id)
    if (!issue) throw new Error('Issue not found')
    if (!issue.instanceId) throw new Error('This issue has no local instance')
    const entries = nodePackService.scanRecovery(issue.instanceId)
    const entry =
      entries.find((e) => e.name === issue.pack) ||
      entries.find((e) => String(issue.pack || '').includes(e.name)) ||
      entries.find((e) => issue.detail.includes(e.path))
    if (!entry) throw new Error('Leftover no longer exists — refresh the issue list')
    nodePackService.cleanRecovery(entry.name, issue.instanceId)
    this.setStatus(id, 'resolved')
    return { ok: true, message: `Removed ${entry.name}` }
  }

  private setStatus(id: string, status: AppIssue['status']): AppIssue | null {
    const all = listIssues()
    let changed: AppIssue | null = null
    const next = all.map((i) => {
      if (i.id !== id) return i
      changed = { ...i, status, updatedAt: Date.now() }
      return changed
    })
    if (changed) replaceIssues(next)
    return changed
  }
}

export const issueHubService = new IssueHubService()
