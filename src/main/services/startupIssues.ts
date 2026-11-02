/**
 * Custom-node startup-failure parsing (0.1.16).
 *
 * Reads the verbatim instance log and reports which node packs failed to
 * import, with a human-readable reason and any missing import names found in
 * the same traceback. Deliberately dependency-free (only `stripAnsi`) so it is
 * trivially unit-testable and usable from the main process.
 */
import { stripAnsi } from '@shared/logLine'
import type { InstanceStartupIssue, InstanceStartupIssues } from '@shared/types'

/** Pull the custom-node pack folder out of any path mentioning `custom_nodes`. */
export function packFromCustomNodesPath(text: string): string | null {
  // 0.2.0: allow spaces in pack names. The old `[^\\/\s"']+` truncated
  // `custom_nodes/My Pack/...` to `My`, so the UI linked to a non-existent pack.
  const m = String(text || '').match(/custom_nodes[\\/]([^\\/"'\r\n]+)/i)
  return m ? m[1].trim() : null
}

/** Modules that are platform/accelerator optional and never block a pack. */
const OPTIONAL_MODULES = new Set(['torch_npu', 'OpenGL_accelerate', 'torch_npu.utils'])

/**
 * Parse recent instance-log lines for custom-node import failures.
 *
 * Attribution: any traceback `custom_nodes/<pack>/...` path anchors the
 * current pack, so a following `No module named 'x'` is credited correctly.
 */
export function parseStartupIssues(
  instanceId: string,
  messages: string[],
  scannedAt = Date.now()
): InstanceStartupIssues {
  const order: string[] = []
  const byPack = new Map<string, InstanceStartupIssue>()
  let lastPack: string | null = null
  /**
   * A bare `No module named` is only a failure when a traceback/IMPORT FAILED
   * line opened a failure context. Manager probes print the same words for
   * optional accelerators on platforms that do not have them.
   */
  let failureContext = false

  const ensure = (pack: string, summary?: string): InstanceStartupIssue => {
    let rec = byPack.get(pack)
    if (!rec) {
      rec = { pack, summary: summary || 'Import failed', missingModules: [] }
      byPack.set(pack, rec)
      order.push(pack)
    } else if (summary) {
      rec.summary = summary
    }
    return rec
  }

  for (const raw of messages) {
    const text = stripAnsi(raw).trim()
    if (!text) continue

    // A new Import-times/prestartup section is a fresh attribution boundary.
    if (/^(Import|Prestartup) times for custom nodes:/i.test(text)) {
      lastPack = null
      failureContext = false
      continue
    }

    // Any traceback file path mentioning a custom-node pack anchors attribution.
    const pathPack = packFromCustomNodesPath(text)
    if (pathPack) {
      lastPack = pathPack
      // A custom_nodes path in a line that also looks like a traceback/file
      // reference is enough to attribute following errors.
      if (/traceback|file\s+"/i.test(text) || /\.py["':,]/i.test(text)) failureContext = true
    }

    const failed = text.match(/\((IMPORT|PRESTARTUP) FAILED\):\s*(.+?)\s*$/i)
    if (failed) {
      const pack: string = packFromCustomNodesPath(failed[2]) || lastPack || 'unknown'
      // No summary here — keep a richer reason if a `Cannot import …` line
      // already supplied one (the IMPORT FAILED line often comes after it).
      ensure(pack)
      lastPack = pack
      failureContext = true
      continue
    }
    const cannot = text.match(/Cannot import\s+(.+?)\s+module for custom nodes:?\s*(.*)$/i)
    if (cannot) {
      const pack: string = packFromCustomNodesPath(cannot[1]) || lastPack || 'unknown'
      ensure(pack, cannot[2].trim() || 'Import failed')
      lastPack = pack
      failureContext = true
      continue
    }
    if (/Nodes have been temporarily disabled due to the error/i.test(text)) {
      ensure(lastPack || 'unknown', 'Dependency install or init failed at runtime')
      failureContext = true
      continue
    }
    const missing = text.match(/No module named '([^']+)'/)
    if (missing && lastPack && failureContext) {
      const rec = ensure(lastPack, 'Missing dependency')
      if (OPTIONAL_MODULES.has(missing[1])) {
        rec.optionalModules = [...new Set([...(rec.optionalModules || []), missing[1]])]
      } else if (!rec.missingModules.includes(missing[1])) {
        rec.missingModules.push(missing[1])
      }
    }
  }

  const issues = order
    .map((p) => byPack.get(p) as InstanceStartupIssue)
    // 0.2.0: a pack whose only missing imports are platform/accelerator
    // optional (`torch_npu` on non-Ascend, `OpenGL_accelerate`) is healthy.
    // Drop it instead of showing "节点加载失败" forever.
    .filter((issue) => !(issue.missingModules.length === 0 && issue.optionalModules?.length))
  return { instanceId, hasIssues: issues.length > 0, issues, scannedAt }
}
