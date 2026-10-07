import { describe, it, expect } from 'vitest'
import { matchesQuery, mapRegistryPack } from '../../src/main/services/registry'

describe('registry search matching', () => {
  const node = {
    id: 'comfyui-controlnet-aux',
    name: 'comfyui_controlnet_aux',
    displayName: 'ControlNet Auxiliary Preprocessors',
    description: 'ControlNet preprocessors for OpenPose, Canny, Depth',
    publisher: { name: 'Fannovel16' },
    tags: ['controlnet', 'preprocessor'],
    downloads: 1000,
    latest_version: '1.0.0'
  }

  it('matches name / description / author / tags (AND words)', () => {
    expect(matchesQuery(node, 'controlnet')).toBe(true)
    expect(matchesQuery(node, 'OpenPose')).toBe(true)
    expect(matchesQuery(node, 'Fannovel16')).toBe(true)
    expect(matchesQuery(node, 'preprocessor')).toBe(true)
    expect(matchesQuery(node, 'controlnet preprocessor')).toBe(true)
    expect(matchesQuery(node, 'controlnet flux')).toBe(false)
    expect(matchesQuery(node, '   ')).toBe(true)
  })

  it('maps registry packs with stable fields', () => {
    const pack = mapRegistryPack(node)
    expect(pack.name).toBe('comfyui_controlnet_aux')
    expect(pack.author).toBe('Fannovel16')
    expect(pack.latestVersion).toBe('1.0.0')
    expect(pack.tags).toContain('controlnet')
  })
})
