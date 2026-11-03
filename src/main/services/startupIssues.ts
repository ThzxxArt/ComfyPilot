/**
 * Custom-node startup-failure parsing (0.1.16).
 *
 * Reads the verbatim instance log and reports which node packs failed to
 * import, with a human-readable reason and any missing import names found in
 * the same traceback. Deliberately dependency-free (only `stripAnsi`) so it is
 * trivially unit-testable and usable from the main process.
 *
 * 0.2.3: distinguish a pack that failed to import from a pack that loaded but
 * had individual optional nodes disabled. ComfyUI logs the latter as
 * `... could not be imported`, `... nodes not available`, or
 * `Error loading <Node>: No module named 'x'`; treating those as pack
 * failures produced permanent `error` issues for optional accelerators such
 * as triton/onnx. The `Import times for custom nodes` block is the ground
 * truth: a pack listed there loaded successfully, so a missing module found
 * in its warnings is optional by definition.
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
 * Node-level degradation phrases. They mean one node (or one accelerator) is
 * unavailable, not that the pack failed to import. Anchored loosely because
 * every pack words it differently.
 */
const OPTIONAL_NODE_HINT =
  /(could not be imported|could not load|will be unavailable|nodes? not available|package is not installed|error loading [^:]+:)/i

/** One `0.1 seconds: <path>` line inside the import-times block. */
const IMPORT_TIME_LINE = /^\d+(?:\.\d+)? seconds:\s*(.+)$/i

/**
 * Packs that finished importing, from ComfyUI's own `Import times for custom
 * nodes` block. Prestartup entries are deliberately excluded: a prestartup
 * script can fail without preventing the pack from importing later.
 */
function collectLoadedPacks(messages: string[]): Set<string> {
  const loaded = new Set<string>()
  let inImportTimes = false
  for (const raw of messages) {
    const text = stripAnsi(raw).trim()
    if (!text) continue
    if (/^Import times for custom nodes:/i.test(text)) {
      inImportTimes = true
      continue
    }
    if (/^Prestartup times for custom nodes:/i.test(text)) {
      inImportTimes = false
      continue
    }
    if (!inImportTimes) continue
    const m = text.match(IMPORT_TIME_LINE)
    if (!m) {
      // The block is over. A non-time line after it (e.g. the next boot
      // section) must not be read as another loaded pack.
      inImportTimes = false
      continue
    }
    const pack = packFromCustomNodesPath(m[1])
    if (pack) loaded.add(pack)
  }
  return loaded
}

/** Parse recent instance-log lines for custom-node import failures. */
export function parseStartupIssues(
  instanceId: string,
  messages: string[],
  scannedAt = Date.now()
): InstanceStartupIssues {
  const loadedPacks = collectLoadedPacks(messages)
  const order: string[] = []
  const byPack = new Map<string, InstanceStartupIssue>()
  let lastPack: string | null = null
  /**
   * A bare `No module named` is only a failure when a traceback/IMPORT FAILED
   * line opened a failure context *for the current pack*. Manager probes print
   * the same words for optional accelerators on platforms that do not have
   * them, and a previous pack's traceback must not leak into the next pack.
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

  const markOptional = (rec: InstanceStartupIssue, module: string): void => {
    rec.optionalModules = [...new Set([...(rec.optionalModules || []), module])]
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

    // "Trying to load custom node <path>" opens a fresh pack context. Resetting
    // failureContext here is what stops pack A's traceback from being credited
    // to the optional warning that pack B prints next.
    const trying = text.match(/Trying to load custom node\s+(.+)$/i)
    if (trying) {
      lastPack = packFromCustomNodesPath(trying[1]) || lastPack
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
    if (missing && lastPack) {
      const module = missing[1]
      const optionalHint = OPTIONAL_NODE_HINT.test(text)
      // `OPTIONAL_MODULES` covers accelerators that cannot exist on this
      // platform even when the pack itself failed for another reason.
      // Loaded packs are handled by the import-times cross-check below, so
      // there is exactly one authority for "the pack actually imported".
      const optional = OPTIONAL_MODULES.has(module) || optionalHint
      if (optional) {
        // No summary: if the pack also has a real failure, the existing
        // "Missing dependency" summary must win over this optional note.
        markOptional(ensure(lastPack), module)
      } else if (failureContext) {
        const rec = ensure(lastPack, 'Missing dependency')
        if (!rec.missingModules.includes(module)) rec.missingModules.push(module)
      }
    }
  }

  // Final cross-check: ComfyUI's import-times block wins over traceback
  // heuristics. A listed pack is loaded, so a missing module attributed to it
  // can only be an optional feature.
  for (const issue of byPack.values()) {
    if (!loadedPacks.has(issue.pack) || !issue.missingModules.length) continue
    for (const module of issue.missingModules) markOptional(issue, module)
    issue.missingModules = []
    if (issue.summary === 'Missing dependency') issue.summary = 'Optional feature unavailable'
  }

  const issues = order
    .map((p) => byPack.get(p) as InstanceStartupIssue)
    // 0.2.0: a pack whose only missing imports are platform/accelerator
    // optional (`torch_npu` on non-Ascend, `OpenGL_accelerate`) is healthy.
    // Drop it instead of showing "节点加载失败" forever.
    .filter((issue) => !(issue.missingModules.length === 0 && issue.optionalModules?.length))
  return { instanceId, hasIssues: issues.length > 0, issues, scannedAt }
}
