/** Workflow preflight pure helpers (0.1.12). */
import { describe, it, expect } from 'vitest'
import {
  collectPromptModelRefs,
  collectPromptNodeTypes,
  missingNodeTypes
} from '../../src/shared/preflight'

const PROMPT = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: {} },
  '48': { class_type: 'PathchSageAttentionKJ', inputs: {} },
  '49': { class_type: 'KSampler', inputs: {} },
  '50': { class_type: 'KSampler', inputs: {} },
  bogus: { not_a_node: true },
  '51': 'not an object'
}

describe('collectPromptNodeTypes', () => {
  it('collects unique class types and tolerates malformed entries', () => {
    expect(collectPromptNodeTypes(PROMPT)).toEqual([
      'CheckpointLoaderSimple',
      'KSampler',
      'PathchSageAttentionKJ'
    ])
  })

  it('returns [] for non-objects', () => {
    expect(collectPromptNodeTypes(null)).toEqual([])
    expect(collectPromptNodeTypes('x')).toEqual([])
    expect(collectPromptNodeTypes([1, 2])).toEqual([])
  })
})

describe('missingNodeTypes', () => {
  it('diffs prompt types against the instance node set', () => {
    const available = new Set(['CheckpointLoaderSimple', 'KSampler'])
    expect(missingNodeTypes(PROMPT, available)).toEqual(['PathchSageAttentionKJ'])
  })

  it('is empty when everything is registered', () => {
    const available = ['CheckpointLoaderSimple', 'KSampler', 'PathchSageAttentionKJ']
    expect(missingNodeTypes(PROMPT, available)).toEqual([])
  })
})

describe('collectPromptModelRefs (0.1.18 / WP7)', () => {
  it('collects model filenames with their owning node type, de-duplicated', () => {
    const prompt = {
      '1': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'SDXL/base.safetensors' }
      },
      '2': { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors' } },
      '3': {
        class_type: 'LoraLoader',
        inputs: { lora_name: 'style.safetensors', strength_model: 0.8 }
      },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat, masterpiece.jpg' } }
    }
    const refs = collectPromptModelRefs(prompt)
    expect(refs).toEqual([
      { name: 'SDXL/base.safetensors', nodeType: 'CheckpointLoaderSimple' },
      { name: 'style.safetensors', nodeType: 'LoraLoader' }
    ])
  })

  it('ignores non-model strings and malformed prompts', () => {
    expect(collectPromptModelRefs(null)).toEqual([])
    expect(collectPromptModelRefs({})).toEqual([])
    expect(
      collectPromptModelRefs({
        '1': { class_type: 'X', inputs: { text: 'hello.safetensors' } } // not an extension-only test
      })
    ).toEqual([{ name: 'hello.safetensors', nodeType: 'X' }])
    expect(
      collectPromptModelRefs({ '1': { class_type: 'X', inputs: { seed: 42, image: 'a.png' } } })
    ).toEqual([])
  })
})
