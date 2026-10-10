/**
 * ComfyUI workflow → API prompt conversion.
 *
 * Formats:
 *  - API:  { "<id>": { class_type, inputs } }
 *  - UI:   { nodes, links, ... }
 *
 * Widget mapping strategy:
 *  1. Prefer builtin widget order tables for popular node types
 *  2. Else node.widgets[].name metadata when present
 *  3. Else map widgets_values to widget-backed inputs only when the full order is known
 * Leftover values are filled into unlinked inputs by type, then declaration order.
 */
export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>

interface UiNode {
  id: number | string
  type: string
  mode?: number
  inputs?: Array<{ name: string; link?: number | null; widget?: { name?: string }; type?: string }>
  outputs?: Array<{ links?: number[] | null; name?: string }>
  widgets_values?: unknown[]
  widgets?: Array<{ name?: string }>
  properties?: Record<string, unknown>
}

interface UiWorkflow {
  nodes?: UiNode[]
  links?: Array<[number, number, number, number, number, string] | number[]>
}

/** Node types that must never enter the API prompt. */
const NON_EXECUTABLE_TYPES = new Set([
  'Note',
  'Reroute',
  'PrimitiveNode',
  'Primitive',
  'Group',
  'MarkdownNote'
])

/** Widget names that exist only in the UI and must NOT be sent as API inputs. */
const UI_ONLY_WIDGETS = new Set([
  'control_after_generate',
  'upload',
  'choose file to upload',
  'image_upload',
  'audio_upload',
  'video_upload',
  'auto',
  'fixed',
  'increment',
  'decrement',
  'randomize'
])

/**
 * Common widget orders for built-in / popular nodes.
 * First N widgets_values map to these names in order.
 */
const WIDGET_ORDER: Record<string, string[]> = {
  KSampler: ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
  CheckpointLoaderSimple: ['ckpt_name'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  CLIPTextEncode: ['text'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  LatentUpscale: ['upscale_method', 'width', 'height', 'crop', 'samples'],
  LatentUpscaleBy: ['upscale_method', 'scale_by', 'samples'],
  SaveImage: ['filename_prefix'],
  LoadImage: ['image', 'upload'],
  LoadAudio: ['audio', 'upload'],
  LoadVideo: ['video', 'force_rate', 'force_size', 'custom_width', 'custom_height', 'frame_load_cap', 'skip_first_frames', 'select_every_nth'],
  PreviewImage: [],
  ImageScale: ['upscale_method', 'width', 'height', 'crop', 'image'],
  ImageScaleBy: ['upscale_method', 'scale_by', 'image'],
  VAEDecode: ['samples', 'vae'],
  VAEEncode: ['pixels', 'vae'],
  ControlNetApplyAdvanced: ['strength', 'start_percent', 'end_percent', 'positive', 'negative', 'control_net', 'image', 'vae'],
  ConditioningCombine: ['conditioning_1', 'conditioning_2'],
  ConditioningConcat: ['conditioning_to', 'conditioning_from'],
  ConditioningSetArea: ['conditioning', 'width', 'height', 'x', 'y', 'strength'],
  ConditioningSetMask: ['conditioning', 'mask', 'set_cond_area', 'strength'],
  LatentComposite: ['samples_to', 'samples_from', 'x', 'y', 'resize_source'],
  LatentBlend: ['samples1', 'samples2', 'blend_factor'],
  SetLatentNoiseMask: ['samples', 'mask'],
  RepeatLatentBatch: ['amount', 'samples'],
  LatentFromBatch: ['batch_index', 'length', 'samples'],
  RebatchLatents: ['batch_size', 'samples'],
  ImageBatch: ['image1', 'image2'],
  ImagePadForOutpaint: ['left', 'top', 'right', 'bottom', 'feathering', 'image'],
  unCLIPCheckpointLoader: ['ckpt_name'],
  CheckpointLoader: ['config_name', 'ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type'],
  VAELoader: ['vae_name'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  ModelSamplingDiscrete: ['sampling', 'zsnr'],
  ModelSamplingFlux: ['max_shift', 'base_shift', 'width', 'height'],
  FluxGuidance: ['guidance', 'conditioning'],
  FluxDisableRoPE: ['conditioning'],
  FluxApplyRoPE: ['conditioning', 'pos', 'grid', 'max_size'],
  CLIPVisionLoader: ['clip_name'],
  CLIPVisionEncode: ['crop', 'clip_vision', 'image'],
  StyleModelLoader: ['style_model_name'],
  StyleModelApply: ['style_model', 'conditioning'],
  unCLIPConditioning: ['strength', 'noise_augmentation', 'conditioning', 'clip_vision_output'],
  GLIGENLoader: ['gligen_name'],
  GLIGENTextBoxApply: ['position', 'size', 'conditioning', 'clip', 'gligen_textbox_model', 'text', 'strength'],
  DiffusersLoader: ['unet_path', 'vae_path', 'weight_dtype'],
  DifferentialDiffusion: ['model', 'conditioning'],
  UNETLoaderGGUF: ['unet_name', 'weight_dtype'],
  ControlNetLoader: ['control_net_name'],
  UpscaleModelLoader: ['model_name'],
  LoadImageMask: ['image', 'channel'],
  SAMLoader: ['model_name', 'device_mode']
}

function isNonExecutable(type: string): boolean {
  return (
    NON_EXECUTABLE_TYPES.has(type) ||
    type.startsWith('Note') ||
    type === 'Reroute' ||
    type.startsWith('Primitive')
  )
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

function widgetValueMatchesType(inputType: string | undefined, value: unknown): boolean {
  if (value == null) return true
  if (!inputType) return true
  const t = inputType.toUpperCase()
  if (typeof value === 'number') return t === 'INT' || t === 'FLOAT' || t === 'NUMBER' || t === 'SEED'
  if (typeof value === 'boolean') return t === 'BOOLEAN' || t === 'BOOL'
  if (typeof value === 'string') return t !== 'INT' && t !== 'FLOAT' && t !== 'BOOLEAN'
  return false
}

function mapWidgets(node: UiNode, linkedNames: Set<string>): Record<string, unknown> {
  const values = node.widgets_values || []
  const inputs: Record<string, unknown> = {}
  if (!values.length) return inputs

  // Prefer a known full builtin order; else widgets metadata; else widget-backed
  // names only when they cover the complete widgets_values list (never partial).
  let widgetNames: string[] = []
  const knownOrder = WIDGET_ORDER[node.type]
  if (knownOrder && knownOrder.length) {
    widgetNames = knownOrder
  } else if (Array.isArray(node.widgets) && node.widgets.length) {
    widgetNames = node.widgets.map((w) => w?.name || '').filter(Boolean)
  } else {
    const widgetLike = (node.inputs || []).filter((i) => i.widget?.name)
    const names = widgetLike.map((w) => w.widget?.name || w.name)
    if (names.length && names.length === values.length) {
      widgetNames = names
    }
  }

  const used = new Set<number>()
  for (let i = 0; i < values.length; i++) {
    const name = widgetNames[i]
    if (!name) continue
    used.add(i)
    if (UI_ONLY_WIDGETS.has(name)) continue
    if (linkedNames.has(name)) continue
    inputs[name] = values[i]
  }

  // Leftover values → unlinked inputs: type match first, then declaration order
  const leftovers: number[] = []
  for (let i = 0; i < values.length; i++) {
    if (!used.has(i)) leftovers.push(i)
  }
  if (leftovers.length) {
    const candidates = (node.inputs || []).filter(
      (inp) => inp?.name && !linkedNames.has(inp.name) && !(inp.name in inputs) && !UI_ONLY_WIDGETS.has(inp.name)
    )
    const deferred: typeof candidates = []
    for (const inp of candidates) {
      const li = leftovers.findIndex((idx) => widgetValueMatchesType(inp.type, values[idx]))
      if (li >= 0) {
        inputs[inp.name] = values[leftovers[li]]
        leftovers.splice(li, 1)
      } else {
        deferred.push(inp)
      }
    }
    for (const inp of deferred) {
      if (!leftovers.length) break
      inputs[inp.name] = values[leftovers.shift()!]
    }
  }

  return inputs
}

/**
 * Resolve a link origin through Reroute / muted / Note chains to the
 * nearest executable source node+slot.
 */
function resolveLinkOrigin(
  originId: string,
  originSlot: number,
  nodesById: Map<string, UiNode>,
  links: Map<number, [string, number]>,
  seen = new Set<string>()
): [string, number] | null {
  const key = `${originId}:${originSlot}`
  if (seen.has(key)) return null
  seen.add(key)

  const node = nodesById.get(originId)
  if (!node) return null
  if (!isNonExecutable(node.type) && node.mode !== 2 && node.mode !== 4) {
    return [originId, originSlot]
  }

  // Reroute: single in, single out — follow its input link
  if (node.type === 'Reroute') {
    const inLink = node.inputs?.[0]?.link
    if (inLink != null) {
      const prev = links.get(Number(inLink))
      if (prev) return resolveLinkOrigin(prev[0], prev[1], nodesById, links, seen)
    }
    return null
  }

  // Muted / bypassed: ComfyUI bypass reconnects same-index inputs → outputs
  if (node.mode === 2 || node.mode === 4) {
    // Try to find an input with a live link matching this output slot
    const inputs = node.inputs || []
    const inLink = inputs[Math.min(originSlot, inputs.length - 1)]?.link
    if (inLink != null) {
      const prev = links.get(Number(inLink))
      if (prev) return resolveLinkOrigin(prev[0], prev[1], nodesById, links, seen)
    }
  }

  return null
}

export function uiWorkflowToApiPrompt(wf: UiWorkflow): ApiPrompt {
  const prompt: ApiPrompt = {}

  const links = new Map<number, [string, number]>()
  for (const link of wf.links || []) {
    if (!Array.isArray(link) || link.length < 4) continue
    const [linkId, originId, originSlot] = link as number[]
    links.set(Number(linkId), [String(originId), Number(originSlot || 0)])
  }

  const nodesById = new Map<string, UiNode>()
  for (const n of wf.nodes || []) {
    nodesById.set(String(n.id), n)
  }

  for (const node of wf.nodes || []) {
    if (isNonExecutable(node.type)) continue
    // mode 2 = muted / 4 = bypassed in ComfyUI
    if (node.mode === 2 || node.mode === 4) continue

    const nodeId = String(node.id)
    const linkedNames = new Set<string>()
    const inputs: Record<string, unknown> = {}

    for (const input of node.inputs || []) {
      if (input.link != null && links.has(Number(input.link))) {
        const origin = links.get(Number(input.link))!
        const resolved = resolveLinkOrigin(origin[0], origin[1], nodesById, links)
        if (resolved) {
          inputs[input.name] = resolved
          linkedNames.add(input.name)
        }
      }
    }

    Object.assign(inputs, mapWidgets(node, linkedNames))

    prompt[nodeId] = {
      class_type: node.type,
      inputs
    }
  }

  return prompt
}

export function toApiPrompt(raw: unknown): ApiPrompt {
  if (isApiPrompt(raw)) return raw
  if (isUiWorkflow(raw)) {
    const api = uiWorkflowToApiPrompt(raw)
    if (!Object.keys(api).length) throw new Error('UI workflow has no executable nodes')
    return api
  }
  if (raw && typeof raw === 'object') {
    const wrapper = raw as { prompt?: unknown; workflow?: unknown }
    if (wrapper.prompt) return toApiPrompt(wrapper.prompt)
    if (wrapper.workflow) return toApiPrompt(wrapper.workflow)
  }
  throw new Error('Unrecognized workflow format (expect API prompt or UI nodes[] graph)')
}

export function applySeedToPrompt(prompt: ApiPrompt, seed: number): ApiPrompt {
  for (const node of Object.values(prompt)) {
    if (!node.inputs) continue
    if (typeof node.inputs.seed === 'number') node.inputs.seed = seed
    if (typeof node.inputs.noise_seed === 'number') node.inputs.noise_seed = seed
  }
  return prompt
}

/** Per-iteration seed variation for batch jobs. */
export function applySeedForIteration(prompt: ApiPrompt, baseSeed: number, iteration: number): ApiPrompt {
  return applySeedToPrompt(prompt, (baseSeed + iteration) % 2 ** 32)
}

export interface PromptParamOverrides {
  width?: number
  height?: number
  steps?: number
  cfg?: number
}

const WIDTH_KEYS = new Set(['width'])
const HEIGHT_KEYS = new Set(['height'])
const STEPS_KEYS = new Set(['steps'])
const CFG_KEYS = new Set(['cfg'])

/**
 * Apply batch parameter matrix overrides onto an API prompt.
 * Only touches inputs whose current value is a number — never invents fields.
 */
export function applyParamOverrides(prompt: ApiPrompt, o: PromptParamOverrides): ApiPrompt {
  for (const node of Object.values(prompt)) {
    if (!node.inputs) continue
    for (const [k, v] of Object.entries(node.inputs)) {
      if (typeof v !== 'number') continue
      const lk = k.toLowerCase()
      if (o.width != null && WIDTH_KEYS.has(lk)) node.inputs[k] = o.width
      else if (o.height != null && HEIGHT_KEYS.has(lk)) node.inputs[k] = o.height
      else if (o.steps != null && STEPS_KEYS.has(lk)) node.inputs[k] = o.steps
      else if (o.cfg != null && CFG_KEYS.has(lk)) node.inputs[k] = o.cfg
    }
  }
  return prompt
}

/** Full batch prompt transform: seed per iteration + optional size/step/cfg matrix. */
export function buildIterationPrompt(
  raw: unknown,
  opts: {
    iteration: number
    seedMode: 'random' | 'increment' | 'fixed'
    baseSeed?: number
    width?: number
    height?: number
    steps?: number
    cfg?: number
  }
): { prompt: ApiPrompt; seed: number } {
  let seed: number
  if (opts.seedMode === 'fixed') {
    seed = (opts.baseSeed ?? 0) % 2 ** 32
  } else if (opts.seedMode === 'increment') {
    seed = ((opts.baseSeed ?? Date.now()) + opts.iteration) % 2 ** 32
  } else {
    // random — Date.now mixed with iteration so parallel jobs diverge
    seed = (Date.now() + opts.iteration * 9973) % 2 ** 32
  }
  let prompt = toApiPrompt(raw)
  // Deep copy so repeated iterations (or two jobs sharing a graph) never
  // mutate the caller's node inputs in place.
  prompt = JSON.parse(JSON.stringify(prompt)) as ApiPrompt
  prompt = applySeedToPrompt(prompt, seed)
  prompt = applyParamOverrides(prompt, {
    width: opts.width,
    height: opts.height,
    steps: opts.steps,
    cfg: opts.cfg
  })
  return { prompt, seed }
}
