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
  const m = text.match(/custom_nodes[\\/]([^\\/\s"']+)/i)
  return m ? m[1] : null
}

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

    // Any traceback file path mentioning a custom-node pack anchors attribution.
    const pathPack = packFromCustomNodesPath(text)
    if (pathPack) lastPack = pathPack

    const failed = text.match(/\(IMPORT FAILED\):\s*(.+?)\s*$/i)
    if (failed) {
      const pack: string = packFromCustomNodesPath(failed[1]) || lastPack || 'unknown'
      // No summary here — keep a richer reason if a `Cannot import …` line
      // already supplied one (the IMPORT FAILED line often comes after it).
      ensure(pack)
      lastPack = pack
      continue
    }
    const cannot = text.match(/Cannot import\s+(.+?)\s+module for custom nodes:?\s*(.*)$/i)
    if (cannot) {
      const pack: string = packFromCustomNodesPath(cannot[1]) || lastPack || 'unknown'
      ensure(pack, cannot[2].trim() || 'Import failed')
      lastPack = pack
      continue
    }
    if (/Nodes have been temporarily disabled due to the error/i.test(text)) {
      ensure(lastPack || 'unknown', 'Dependency install or init failed at runtime')
      continue
    }
    const missing = text.match(/No module named '([^']+)'/)
    if (missing) {
      const rec = ensure(lastPack || 'unknown', 'Missing dependency')
      if (!rec.missingModules.includes(missing[1])) rec.missingModules.push(missing[1])
    }
  }

  const issues = order.map((p) => byPack.get(p) as InstanceStartupIssue)
  return { instanceId, hasIssues: issues.length > 0, issues, scannedAt }
}
