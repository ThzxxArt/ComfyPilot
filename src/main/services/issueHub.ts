/**
 * IssueCenter single source of truth (0.2.0).
 *
 * Aggregates startup import failures, node-load report rows, dependency-audit
 * results and doctor failures into persisted, de-duplicated issues. Every
 * issue carries at least one action; status survives restarts and a changed
 * fingerprint reopens an ignored/resolved issue.
 */
import type { AppIssue, AppIssueAction, AppIssueKind } from '@shared/types'
import { loadInstanceConfigs, listIssues, replaceIssues } from './db'
import { instanceService } from './instance'
import { nodePackService } from './nodePack'

function fingerprint(parts: Array<string | undefined>): string {
  return parts.map((p) => String(p || '').replace(/[|]/g, '_')).join('|')
}

function nodeLink(instanceId: string, focus: string, source: string): string {
  const q = new URLSearchParams({ instanceId, focus, source })
  return `/nodes?${q.toString()}`
}

function actionsFor(
  kind: AppIssueKind,
  instanceId: string,
  pack: string,
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
  if (pack.includes('.trash') || pack.includes('.bak') || pack.startsWith('._')) {
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
    actions: actionsFor(input.kind, input.instanceId, input.pack || '', input.kind),
    status: 'open',
    firstSeen: now,
    lastSeen: now,
    updatedAt: now
  }
}

function mergeIssues(fresh: AppIssue[]): AppIssue[] {
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
    // issue only reopens when its fingerprint changes, which creates a new id.
    merged.push({
      ...issue,
      firstSeen: prev.firstSeen,
      status: prev.status === 'resolved' || prev.status === 'acknowledged' ? 'open' : prev.status,
      updatedAt: prev.status === 'ignored' ? prev.updatedAt : now
    })
  }
  // Problems that vanished from the latest scan become resolved, unless the
  // user explicitly ignored them.
  for (const [fp, prev] of old) {
    if (seen.has(fp)) continue
    merged.push(
      prev.status === 'ignored'
        ? prev
        : { ...prev, status: 'resolved', lastSeen: now, updatedAt: now }
    )
  }
  replaceIssues(merged)
  return merged
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
    const fresh: AppIssue[] = []
    for (const config of configs) {
      const id = config.id
      // Startup traceback issues.
      try {
        const startup = instanceService.analyzeStartupIssues(id)
        for (const issue of startup.issues) {
          const fp = fingerprint([
            'startup',
            id,
            issue.pack,
            ...(issue.missingModules || []).slice().sort()
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
          const fp = fingerprint(['node-load', id, entry.folder, entry.modulePath])
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
          const fp = fingerprint(['policy', id, refusal.folder, refusal.reason])
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

      // Recorded execution failures (WS + log) from the diagnosis service.
      try {
        const { execDiagnosticsService } = await import('./execDiagnostics')
        for (const failure of execDiagnosticsService.list(id)) {
          const fp = fingerprint([
            'exec',
            id,
            failure.packFolder || failure.nodeType || 'unknown',
            failure.missingModule || failure.errorType,
            failure.id
          ])
          fresh.push(
            makeIssue({
              fingerprint: fp,
              kind: 'exec',
              instanceId: id,
              pack: failure.packFolder,
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
        for (const pack of audit.packs || []) {
          const fp = fingerprint([
            'deps',
            id,
            pack.name,
            ...pack.missing.slice().sort(),
            ...pack.mismatched.map((m) => `${m.name}${m.required}`).sort()
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
        /* audit is advisory */
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
        /* doctor is advisory */
      }
    }
    mergeIssues(fresh)
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
