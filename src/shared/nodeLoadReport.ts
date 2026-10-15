/**
 * Custom-node boot-log parsing (0.1.10) — shared by main (report via IPC) and
 * renderer (status badges). Pure functions over log lines; never guesses.
 *
 * ComfyUI prints on every boot:
 *
 *   Import times for custom nodes:
 *      0.3 seconds: C:\...\custom_nodes\Foo
 *      9.1 seconds (IMPORT FAILED): C:\...\custom_nodes\Bar
 *
 *   Prestartup times for custom nodes:
 *      0.1 seconds (PRESTARTUP FAILED): C:\...\custom_nodes\Baz
 */
import type { NodeLoadEntry, NodeLoadReport } from './types'

const IMPORT_HEADER = 'Import times for custom nodes:'
const PRESTARTUP_HEADER = 'Prestartup times for custom nodes:'
/**
 * Optional `[LEVEL]` prefix (with ANSI SGR codes) added by ComfyUI 0.39+ —
 * see LINE_RE below for the full story.
 */
// eslint-disable-next-line no-control-regex -- ANSI SGR codes are intentional here
const LEVEL_PREFIX_RE = /^(?:\x1b\[[0-9;]*m)*\s*(?:\[[A-Z]+\](?:\x1b\[[0-9;]*m)*\s*)?/

/**
 * Governance refusals (ComfyUI 0.40+, `app/governance.py`). Refused packs are
 * skipped BEFORE loading (`nodes.py`: `continue`), so they never appear in the
 * Import-times block — the only trace is this warning line:
 *
 *   Custom node pack 'Foo' is not permitted by your organization's policy.
 *   Custom node pack 'comfyui-manager' is not loaded: ComfyUI-Manager cannot
 *   run under a custom-node policy, because its startup script installs packs
 *   before they are checked.
 */
const POLICY_REFUSAL_RE =
  /Custom node pack '([^']+)' (is not permitted by your organization's policy|is not loaded: ComfyUI-Manager cannot run under a custom-node policy)/
/**
 * Entry line, tolerating the ANSI level prefix added by ComfyUI 0.39+.
 *
 * 0.39 routes these lines through `app/logger.py`'s ColoredFormatter, which
 * ALWAYS prefixes `[LEVEL] ` with ANSI SGR codes around the tag itself
 * (no isatty gate), e.g. `\x1b[92m[INFO]\x1b[0m    0.3 seconds: C:\...\Foo`.
 * Older builds print the bare line (`   0.3 seconds: ...`). The regex accepts
 * both (and any `[LEVEL]` tag with trailing reset codes), otherwise 0.39 boot
 * logs parse to zero rows and the UI shows "0 ok / 0 failed".
 */

const LINE_RE =
  // eslint-disable-next-line no-control-regex -- ANSI SGR codes are intentional here
  /^(?:\x1b\[[0-9;]*m)*\s*(?:\[[A-Z]+\](?:\x1b\[[0-9;]*m)*\s*)?([\d.]+)\s+seconds(\s+\((IMPORT FAILED|PRESTARTUP FAILED)\))?:\s*(.+?)\s*$/

/** Directory basename of a module path printed by ComfyUI (`.disabled` stripped). */
export function packFolderOf(modulePath: string): string {
  const base =
    String(modulePath || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || ''
  return base.endsWith('.disabled') ? base.slice(0, -'.disabled'.length) : base
}

export function parseNodeLoadReport(
  lines: Array<{ message: string; ts?: number }>
): NodeLoadReport | null {
  let importIdx = -1
  let prestartupIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const msg = lines[i].message
    if (msg.includes(IMPORT_HEADER)) importIdx = i
    if (msg.includes(PRESTARTUP_HEADER)) prestartupIdx = i
  }

  // Governance refusals (0.1.14): refused packs never reach the Import-times
  // block, so scan for their warning lines independently. Newest observation
  // wins per folder (later boots may change the verdict).
  const policyRefused: Array<{ folder: string; reason: 'policy' | 'manager' }> = []
  for (const line of lines) {
    const stripped = line.message.replace(LEVEL_PREFIX_RE, '')
    const m = stripped.match(POLICY_REFUSAL_RE)
    if (!m) continue
    const reason = m[2].startsWith('is not permitted') ? 'policy' : 'manager'
    const existing = policyRefused.findIndex((p) => p.folder === m[1])
    if (existing >= 0) policyRefused.splice(existing, 1)
    policyRefused.push({ folder: m[1], reason })
  }

  if (importIdx < 0 && prestartupIdx < 0) {
    // A run whose every pack was refused has no Import-times block at all —
    // still surface the refusals instead of pretending there is no report.
    return policyRefused.length ? { available: true, entries: [], policyRefused } : null
  }

  // Failure reasons: module path → message.
  const reasons = new Map<string, string>()
  for (const line of lines) {
    const imp = line.message.match(/Cannot import (.+?) module for custom nodes:\s*(.*)$/)
    if (imp) {
      reasons.set(imp[1].trim(), imp[2].trim() || 'Import failed')
      continue
    }
    const skip = line.message.match(
      /Skip (.+?) module for custom nodes due to the lack of NODE_CLASS_MAPPINGS/
    )
    if (skip) {
      reasons.set(skip[1].trim(), 'No NODE_CLASS_MAPPINGS or comfy_entrypoint found')
    }
  }

  const entries: NodeLoadEntry[] = []
  // Emit rows in LOG ORDER: the prestartup block normally prints first.
  const ranges: Array<{ start: number; prestartup: boolean }> = []
  if (prestartupIdx >= 0) ranges.push({ start: prestartupIdx, prestartup: true })
  if (importIdx >= 0) ranges.push({ start: importIdx, prestartup: false })
  ranges.sort((a, b) => a.start - b.start)
  for (const range of ranges) {
    for (let i = range.start + 1; i < lines.length; i++) {
      const msg = lines[i].message
      // Any later header restarts a section (worker logs interleave).
      if (msg.includes(IMPORT_HEADER) || msg.includes(PRESTARTUP_HEADER)) break
      const m = msg.match(LINE_RE)
      if (!m) continue
      const modulePath = m[4]
      const failed = range.prestartup ? m[3] === 'PRESTARTUP FAILED' : m[3] === 'IMPORT FAILED'
      entries.push({
        modulePath,
        folder: packFolderOf(modulePath),
        seconds: Number(m[1]) || 0,
        ok: !failed,
        prestartup: range.prestartup,
        error: failed
          ? reasons.get(modulePath) ||
            (range.prestartup ? 'Prestartup script failed' : 'Import failed')
          : undefined
      })
    }
  }
  const observedAt =
    importIdx >= 0 ? lines[importIdx].ts : prestartupIdx >= 0 ? lines[prestartupIdx].ts : undefined
  return {
    available: true,
    entries,
    policyRefused: policyRefused.length ? policyRefused : undefined,
    observedAt
  }
}

/** Governance refusal for a folder, when its pack was blocked by policy. */
export function packPolicyRefusalOf(
  folder: string,
  report: NodeLoadReport | null | undefined
): { folder: string; reason: 'policy' | 'manager' } | undefined {
  if (!report || !folder) return undefined
  return report.policyRefused?.find((p) => p.folder === folder)
}

/** Per-pack load status derived from the boot-log report (0.1.10). */
export type PackLoadStatus = 'loaded' | 'import-failed' | 'prestartup-failed' | 'unknown'

export function packLoadStatusOf(
  folder: string,
  report: NodeLoadReport | null | undefined
): PackLoadStatus {
  if (!report || !report.available || !folder) return 'unknown'
  const hits = report.entries.filter((e) => e.folder === folder)
  if (!hits.length) return 'unknown'
  if (hits.some((h) => !h.ok && !h.prestartup)) return 'import-failed'
  if (hits.some((h) => !h.ok && h.prestartup)) return 'prestartup-failed'
  return 'loaded'
}

/** First failure detail for a folder, for tooltips. */
export function packLoadFailureOf(
  folder: string,
  report: NodeLoadReport | null | undefined
): NodeLoadEntry | undefined {
  if (!report || !folder) return undefined
  return report.entries.find((e) => e.folder === folder && !e.ok)
}
