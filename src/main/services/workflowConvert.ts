/**
 * ComfyUI workflow → API prompt conversion.
 *
 * Formats:
 *  - API:  { "<id>": { class_type, inputs } }
 *  - UI:   { nodes, links, ... }
 *
 * Widget mapping strategy:
 *  1. Prefer node.widgets[].name metadata when present
 *  2. Else map widgets_values to widget-backed inputs (input.widget.name)
 *  3. Else use builtin widget order tables for popular node types
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
  UNETLoaderGGUF: ['unet_name', 'weight_dtype']
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

function mapWidgets(node: UiNode, linkedNames: Set<string>): Record<string, unknown> {
  const values = node.widgets_values || []
  const inputs: Record<string, unknown> = {}
  if (!values.length) return inputs

  // 1) widgets metadata
  let widgetNames: string[] = []
  if (Array.isArray(node.widgets) && node.widgets.length) {
    widgetNames = node.widgets.map((w) => w?.name || '').filter(Boolean)
  }

  // 2) widget-backed inputs (declared order)
  if (!widgetNames.length) {
    const widgetLike = (node.inputs || []).filter((i) => i.widget?.name)
    widgetNames = widgetLike.map((w) => w.widget?.name || w.name)
  }

  // 3) builtin table
  if (!widgetNames.length) {
    widgetNames = WIDGET_ORDER[node.type] || []
  }

  // Some UI versions pack control_after_generate as a separate widget after seed
  for (let i = 0; i < values.length; i++) {
    const name = widgetNames[i]
    if (!name) continue
    if (UI_ONLY_WIDGETS.has(name)) continue
    if (linkedNames.has(name)) continue
    inputs[name] = values[i]
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
