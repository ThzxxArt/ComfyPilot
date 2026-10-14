/** Workflow preflight pure helpers (0.1.12). */
import { describe, it, expect } from 'vitest'
import { collectPromptNodeTypes, missingNodeTypes } from '../../src/shared/preflight'

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
