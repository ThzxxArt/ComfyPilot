/**
 * ComfyUI workflow → API prompt conversion.
 *
 * Two on-disk formats exist:
 *  - API format: { "<nodeId>": { class_type, inputs } }  — send as-is
 *  - UI format:  { nodes, links, ... }                   — must convert
 *
 * Conversion heuristic (works for standard widgets):
 *  1. Collect link map: linkId -> { fromNode, fromSlot }
 *  2. For each node, wire named inputs with `link` to ["<fromNode>", slot]
 *  3. Remaining widgets_values (excluding converted widget names) fill
 *     widget-backed inputs in declaration order.
 */
export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>

interface UiNode {
  id: number | string
  type: string
  inputs?: Array<{ name: string; link?: number | null; widget?: { name?: string } }>
  outputs?: Array<{ links?: number[] | null }>
  widgets_values?: unknown[]
  widgets?: Array<{ name?: string }>
  properties?: Record<string, unknown>
}

interface UiWorkflow {
  nodes?: UiNode[]
  links?: Array<[number, number, number, number, number, string] | number[]>
  extra?: Record<string, unknown>
}

export function isApiPrompt(value: unknown): value is ApiPrompt {
  if (!value || typeof value !== 'object') return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (!entries.length) return false
  return entries.every(([, v]) => {
    const n = v as { class_type?: string; inputs?: unknown }
    return typeof n?.class_type === 'string' && n.inputs && typeof n.inputs === 'object'
  })
}

export function isUiWorkflow(value: unknown): value is UiWorkflow {
  if (!value || typeof value !== 'object') return false
  const v = value as UiWorkflow
  return Array.isArray(v.nodes)
}

/** Convert UI workflow JSON to API prompt graph. */
export function uiWorkflowToApiPrompt(wf: UiWorkflow): ApiPrompt {
  const prompt: ApiPrompt = {}
  const nodesById = new Map<string, UiNode>()
  for (const n of wf.nodes || []) {
    nodesById.set(String(n.id), n)
  }

  // linkId -> [fromNodeId, fromSlotIndex]
  const links = new Map<number, [string, number]>()
  for (const link of wf.links || []) {
    if (!Array.isArray(link) || link.length < 4) continue
    const [linkId, originId, originSlot] = link as number[]
    links.set(Number(linkId), [String(originId), Number(originSlot || 0)])
  }

  for (const node of wf.nodes || []) {
    const nodeId = String(node.id)
    const inputs: Record<string, unknown> = {}

    // 1) graph-linked inputs
    const linkedNames = new Set<string>()
    for (const input of node.inputs || []) {
      if (input.link != null && links.has(Number(input.link))) {
        inputs[input.name] = links.get(Number(input.link))
        linkedNames.add(input.name)
      }
    }

    // 2) widget values → input names
    // Prefer node.widgets names; fall back to known ComfyUI widget ordering.
    const widgetNames: string[] = []
    if (Array.isArray((node as { widgets?: Array<{ name?: string }> }).widgets)) {
      for (const w of (node as { widgets: Array<{ name?: string }> }).widgets) {
        if (w?.name) widgetNames.push(w.name)
      }
    } else if (Array.isArray(node.widgets_values)) {
      // Without widget metadata, map remaining values by common slot names if inputs declare widgets
      const widgetLike = (node.inputs || []).filter((i) => i.widget?.name)
      for (const w of widgetLike) widgetNames.push(w.widget?.name || w.name)
    }

    const values = node.widgets_values || []
    if (widgetNames.length && values.length) {
      // ComfyUI sometimes packs combo widgets as single values; map 1:1 until exhausted.
      for (let i = 0; i < widgetNames.length && i < values.length; i++) {
        const name = widgetNames[i]
        if (linkedNames.has(name)) continue
        inputs[name] = values[i]
      }
    } else {
      // Last resort: leave inputs empty but keep class_type so user sees the node.
    }

    prompt[nodeId] = {
      class_type: node.type,
      inputs
    }
  }

  return prompt
}

/**
 * Normalize any loaded workflow JSON into an API prompt.
 * Throws a clear error when conversion is impossible.
 */
export function toApiPrompt(raw: unknown): ApiPrompt {
  if (isApiPrompt(raw)) return raw
  if (isUiWorkflow(raw)) {
    const api = uiWorkflowToApiPrompt(raw)
    if (!Object.keys(api).length) throw new Error('UI workflow has no nodes')
    return api
  }
  // Sometimes saved as { prompt: {...} } or { workflow: {...} }
  if (raw && typeof raw === 'object') {
    const wrapper = raw as { prompt?: unknown; workflow?: unknown }
    if (wrapper.prompt) return toApiPrompt(wrapper.prompt)
    if (wrapper.workflow) return toApiPrompt(wrapper.workflow)
  }
  throw new Error('Unrecognized workflow format (expect API prompt or UI nodes[] graph)')
}

export function applySeedToPrompt(prompt: ApiPrompt, seed: number): ApiPrompt {
  for (const node of Object.values(prompt)) {
    if (node.inputs && typeof node.inputs.seed === 'number') {
      node.inputs.seed = seed
    }
  }
  return prompt
}
