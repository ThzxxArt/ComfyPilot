import { describe, expect, it } from 'vitest'
import { parseManagerChannelPayload } from '../../src/main/services/nodePack/list'

describe('Manager channel schema (0.2.5 WP4)', () => {
  it('parses the real v4 {custom_nodes:[...]} shape', () => {
    const items = parseManagerChannelPayload({
      custom_nodes: [
        {
          title: 'ComfyUI-Impact-Pack',
          reference: 'https://github.com/ltdrdata/ComfyUI-Impact-Pack',
          files: ['https://github.com/ltdrdata/ComfyUI-Impact-Pack/archive/refs/heads/Main.zip'],
          install_type: 'git-clone',
          description: 'Impact',
          author: 'ltdrdata',
          version: '8.0.0',
          tags: ['nodes']
        }
      ]
    })
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('ComfyUI-Impact-Pack')
    expect(items[0].repository).toBe('https://github.com/ltdrdata/ComfyUI-Impact-Pack')
    expect(items[0].files?.[0]).toContain('archive')
    expect(items[0].installType).toBe('git-clone')
    expect(items[0].latestVersion).toBe('8.0.0')
  })

  it('accepts an extension-node-map object and marks banned/flagged entries', () => {
    const items = parseManagerChannelPayload({
      KSampler: [{ name: 'core', banned: true }],
      'SomeNode': [{ title: 'Pack', reference: 'https://example.com/x.git', flagged: true }]
    })
    expect(items.map((i) => i.id)).toEqual(['KSampler', 'SomeNode'])
    expect(items[0].status).toBe('banned')
    expect(items[1].status).toBe('flagged')
  })

  it('deduplicates ids and ignores malformed entries', () => {
    const items = parseManagerChannelPayload({
      custom_nodes: [
        { title: 'A', reference: 'https://a.example/x' },
        { title: 'A', reference: 'https://a.example/y' },
        null,
        { description: 'no id' }
      ]
    })
    expect(items).toHaveLength(1)
    expect(items[0].displayName).toBe('A')
  })

  it('negative: a malformed payload yields an empty list, never throws', () => {
    expect(parseManagerChannelPayload(null)).toEqual([])
    expect(parseManagerChannelPayload('nope')).toEqual([])
    expect(parseManagerChannelPayload({ custom_nodes: 'nope' })).toEqual([])
  })
})
