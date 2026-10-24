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

/**
 * 0.1.18 (WP7): model files a workflow references. ComfyUI passes model names
 * as plain string inputs (`ckpt_name`, `lora_name`, …); the extension is the
 * only reliable signal, so anything else (positive prompts, filenames without
 * a model extension) is deliberately ignored.
 */
const MODEL_FILE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/i

export function collectPromptModelRefs(prompt: unknown): Array<{ name: string; nodeType: string }> {
  if (!prompt || typeof prompt !== 'object') return []
  const seen = new Map<string, { name: string; nodeType: string }>()
  for (const node of Object.values(prompt as Record<string, unknown>)) {
    if (!node || typeof node !== 'object') continue
    const type = String((node as { class_type?: unknown }).class_type || '')
    const inputs = (node as { inputs?: unknown }).inputs
    if (!inputs || typeof inputs !== 'object') continue
    for (const value of Object.values(inputs as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      if (!MODEL_FILE_RE.test(value)) continue
      if (value.includes('\0')) continue
      const key = value.toLowerCase()
      if (!seen.has(key)) seen.set(key, { name: value, nodeType: type })
    }
  }
  return [...seen.values()]
}
