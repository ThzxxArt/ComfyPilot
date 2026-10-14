/**
 * Workflow preflight (0.1.12, WP6) — pure helpers shared by main + tests.
 *
 * The API-format prompt (`{ "48": { class_type: "PathchSageAttentionKJ", … } }`)
 * is compared against the running instance's `/object_info` node-type set.
 * Only class-type presence is checked (ComfyUI exposes nothing about lazy
 * imports — dependency-level checks happen after a real failure, by design).
 */

/** Collect unique class_type values from an API-format prompt. */
export function collectPromptNodeTypes(prompt: unknown): string[] {
  if (!prompt || typeof prompt !== 'object') return []
  const out = new Set<string>()
  for (const node of Object.values(prompt as Record<string, unknown>)) {
    if (!node || typeof node !== 'object') continue
    const ct = (node as { class_type?: unknown }).class_type
    if (typeof ct === 'string' && ct) out.add(ct)
  }
  return [...out].sort()
}

/** Node types present in the prompt but missing from the instance node set. */
export function missingNodeTypes(prompt: unknown, availableTypes: Iterable<string>): string[] {
  const available = new Set(availableTypes)
  return collectPromptNodeTypes(prompt).filter((t) => !available.has(t))
}
