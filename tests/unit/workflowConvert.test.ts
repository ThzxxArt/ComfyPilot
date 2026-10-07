import { describe, it, expect } from 'vitest'
import {
  isApiPrompt,
  isUiWorkflow,
  uiWorkflowToApiPrompt,
  toApiPrompt,
  applySeedToPrompt,
  applySeedForIteration
} from '../../src/main/services/workflowConvert'

describe('format detection', () => {
  it('detects API prompt', () => {
    expect(
      isApiPrompt({
        '3': { class_type: 'KSampler', inputs: { seed: 1 } }
      })
    ).toBe(true)
    expect(isApiPrompt({ nodes: [] })).toBe(false)
  })

  it('detects UI workflow', () => {
    expect(isUiWorkflow({ nodes: [{ id: 1, type: 'KSampler' }] })).toBe(true)
    expect(isUiWorkflow({ foo: 1 })).toBe(false)
  })
})

describe('uiWorkflowToApiPrompt', () => {
  const kSampler = {
    id: 3,
    type: 'KSampler',
    inputs: [
      { name: 'model', link: 1 },
      { name: 'positive', link: 2 },
      { name: 'negative', link: 3 },
      { name: 'latent_image', link: 4 }
    ],
    widgets_values: [12345, 'randomize', 20, 8.0, 'euler', 'normal', 1.0]
  }

  const checkpoint = {
    id: 4,
    type: 'CheckpointLoaderSimple',
    inputs: [],
    widgets_values: ['model.safetensors']
  }

  it('maps widgets and skips UI-only names', () => {
    const api = uiWorkflowToApiPrompt({
      nodes: [checkpoint, kSampler],
      links: []
    })
    expect(api['3'].class_type).toBe('KSampler')
    expect(api['3'].inputs.seed).toBe(12345)
    expect(api['3'].inputs.steps).toBe(20)
    expect(api['3'].inputs.cfg).toBe(8.0)
    // control_after_generate must not be an API input
    expect(api['3'].inputs).not.toHaveProperty('control_after_generate')
    expect(api['4'].inputs.ckpt_name).toBe('model.safetensors')
  })

  it('filters Note / Reroute / muted nodes', () => {
    const api = uiWorkflowToApiPrompt({
      nodes: [
        { id: 1, type: 'Note', widgets_values: [] },
        { id: 2, type: 'Reroute', inputs: [], outputs: [] },
        { id: 3, type: 'KSampler', mode: 2, widgets_values: [1, 'fixed', 10, 7, 'euler', 'normal', 1] },
        { id: 4, type: 'CLIPTextEncode', mode: 4, widgets_values: ['hi'] },
        { id: 5, type: 'SaveImage', widgets_values: ['out'] }
      ]
    })
    expect(api['1']).toBeUndefined()
    expect(api['2']).toBeUndefined()
    expect(api['3']).toBeUndefined()
    expect(api['4']).toBeUndefined()
    expect(api['5']).toBeTruthy()
  })

  it('keeps executable LoRA pack types', () => {
    const api = uiWorkflowToApiPrompt({
      nodes: [{ id: 1, type: 'Power Lora Loader (rgthree)', widgets_values: [] }]
    })
    expect(api['1']).toBeTruthy()
  })

  it('rewires links through Reroute chain', () => {
    // model source (id 10) → reroute (id 11) → ksample (id 3)
    const nodes = [
      {
        id: 10,
        type: 'CheckpointLoaderSimple',
        inputs: [],
        outputs: [{ name: 'MODEL', links: [100] }],
        widgets_values: ['m.safetensors']
      },
      {
        id: 11,
        type: 'Reroute',
        inputs: [{ name: 'input', link: 100 }],
        outputs: [{ name: 'output', links: [101] }],
        widgets_values: []
      },
      {
        id: 3,
        type: 'KSampler',
        inputs: [
          { name: 'model', link: 101 },
          { name: 'positive', link: null },
          { name: 'negative', link: null },
          { name: 'latent_image', link: null }
        ],
        widgets_values: [1, 'fixed', 10, 7, 'euler', 'normal', 1]
      }
    ]
    const links: Array<[number, number, number, number, number, string]> = [
      [100, 10, 0, 11, 0, 'MODEL'],
      [101, 11, 0, 3, 0, 'MODEL']
    ]
    const api = uiWorkflowToApiPrompt({ nodes, links })
    expect(api['3'].inputs.model).toEqual(['10', 0])
  })

  it('drops dangling links to missing nodes', () => {
    const api = uiWorkflowToApiPrompt({
      nodes: [
        {
          id: 3,
          type: 'KSampler',
          inputs: [{ name: 'model', link: 999 }],
          widgets_values: [1, 'fixed', 10, 7, 'euler', 'normal', 1]
        }
      ],
      links: [[999, 404, 0, 3, 0, 'MODEL']]
    })
    expect(api['3'].inputs.model).toBeUndefined()
    expect(api['3'].inputs.seed).toBe(1)
  })

  it('does not shift values when some widgets became linked inputs', () => {
    // seed is converted to an input widget → widget-backed names would be partial
    const api = uiWorkflowToApiPrompt({
      nodes: [
        {
          id: 3,
          type: 'KSampler',
          inputs: [
            { name: 'seed', link: 50, widget: { name: 'seed' } },
            { name: 'model', link: 1 },
            { name: 'positive', link: 2 },
            { name: 'negative', link: 3 },
            { name: 'latent_image', link: 4 }
          ],
          widgets_values: [12345, 'randomize', 20, 8.0, 'euler', 'normal', 1.0]
        },
        {
          id: 9,
          type: 'SeedNode',
          widgets_values: [999]
        }
      ],
      links: [[50, 9, 0, 3, 0, 'INT']]
    })
    expect(api['3'].inputs.seed).toEqual(['9', 0])
    expect(api['3'].inputs.steps).toBe(20)
    expect(api['3'].inputs.cfg).toBe(8.0)
    expect(api['3'].inputs.sampler_name).toBe('euler')
    expect(api['3'].inputs.scheduler).toBe('normal')
    expect(api['3'].inputs.denoise).toBe(1.0)
  })

  it('maps loader widgets for types without widgets metadata', () => {
    const api = uiWorkflowToApiPrompt({
      nodes: [
        { id: 1, type: 'ControlNetLoader', widgets_values: ['control_v11p.pth'] },
        { id: 2, type: 'UpscaleModelLoader', widgets_values: ['4x-UltraSharp.pth'] },
        { id: 3, type: 'LoadImageMask', widgets_values: ['mask.png', 'alpha'] },
        { id: 4, type: 'SAMLoader', widgets_values: ['sam_vit_b.pth', 'AUTO'] }
      ]
    })
    expect(api['1'].inputs.control_net_name).toBe('control_v11p.pth')
    expect(api['2'].inputs.model_name).toBe('4x-UltraSharp.pth')
    expect(api['3'].inputs.image).toBe('mask.png')
    expect(api['3'].inputs.channel).toBe('alpha')
    expect(api['4'].inputs.model_name).toBe('sam_vit_b.pth')
    expect(api['4'].inputs.device_mode).toBe('AUTO')
  })

  it('fills leftover widgets into unlinked inputs without throwing', () => {
    const api = uiWorkflowToApiPrompt({
      nodes: [
        {
          id: 5,
          type: 'CustomUnknownNode',
          inputs: [
            { name: 'strength', link: null, type: 'FLOAT' },
            { name: 'mode', link: null, type: 'STRING' }
          ],
          widgets_values: [0.75, 'soft']
        }
      ]
    })
    expect(api['5'].inputs.strength).toBe(0.75)
    expect(api['5'].inputs.mode).toBe('soft')
  })
})

describe('toApiPrompt wrappers', () => {
  it('unwraps prompt / workflow wrappers', () => {
    const api = toApiPrompt({
      prompt: { '1': { class_type: 'SaveImage', inputs: {} } }
    })
    expect(api['1']).toBeTruthy()
    expect(() => toApiPrompt({ foo: 1 })).toThrow()
  })
})

describe('seed application', () => {
  const prompt = {
    a: { class_type: 'KSampler', inputs: { seed: 1, noise_seed: 2 } },
    b: { class_type: 'KSamplerAdvanced', inputs: { noise_seed: 9 } }
  }

  it('sets seed and noise_seed', () => {
    const out = applySeedToPrompt(structuredClone(prompt), 77)
    expect(out.a.inputs.seed).toBe(77)
    expect(out.a.inputs.noise_seed).toBe(77)
    expect(out.b.inputs.noise_seed).toBe(77)
  })

  it('iterations get different seeds', () => {
    const s0 = applySeedForIteration(structuredClone(prompt), 100, 0)
    const s1 = applySeedForIteration(structuredClone(prompt), 100, 1)
    expect(s0.a.inputs.seed).toBe(100)
    expect(s1.a.inputs.seed).toBe(101)
  })
})
