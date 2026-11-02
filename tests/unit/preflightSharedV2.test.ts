import { describe, expect, it } from 'vitest'
import { modelCategoryForInput } from '../../src/shared/preflight'

describe('modelCategoryForInput (0.2.0)', () => {
  it('maps every known ComfyUI model input to its library category', () => {
    const cases: Array<[string, string | undefined]> = [
      ['ckpt_name', 'checkpoints'],
      ['lora_name', 'loras'],
      ['vae_name', 'vae'],
      ['control_net_name', 'controlnet'],
      ['controlnet_name', 'controlnet'],
      ['clip_name', 'text_encoders'],
      ['clip_name1', 'text_encoders'],
      ['clip_name2', 'text_encoders'],
      ['clip_vision', 'clip_vision'],
      ['clip_vision_name', 'clip_vision'],
      ['unet_name', 'diffusion_models'],
      ['model_name', 'diffusion_models'],
      ['upscale_model_name', 'upscale_models'],
      ['style_model_name', 'style_models'],
      ['gligen_name', 'gligen'],
      ['seed', undefined]
    ]
    for (const [input, expected] of cases) {
      expect(modelCategoryForInput(input)).toBe(expected)
    }
  })
})
