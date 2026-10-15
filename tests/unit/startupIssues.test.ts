import { describe, it, expect } from 'vitest'
import { parseStartupIssues, packFromCustomNodesPath } from '../../src/main/services/startupIssues'

describe('startupIssues (0.1.16)', () => {
  it('extracts a pack folder from a custom_nodes path', () => {
    expect(packFromCustomNodesPath('File "D:/x/custom_nodes/ComfyUI-RMBG/py/a.py", line 3')).toBe(
      'ComfyUI-RMBG'
    )
    expect(packFromCustomNodesPath('nothing here')).toBeNull()
  })

  it('attributes a missing module to the pack named in the traceback', () => {
    const lines = [
      'Traceback (most recent call last):',
      '  File "D:\\ComfyUI\\custom_nodes\\ComfyUI-RMBG\\models\\sam3\\train\\data\\x.py", line 18',
      '    from decord import cpu, VideoReader',
      "ModuleNotFoundError: No module named 'decord'",
      'During handling of the above exception, another exception occurred:',
      "Cannot import D:\\ComfyUI\\custom_nodes\\ComfyUI-RMBG module for custom nodes: name 'module_name' is not defined",
      '0.3 seconds (IMPORT FAILED): D:\\ComfyUI\\custom_nodes\\ComfyUI-RMBG'
    ]
    const r = parseStartupIssues('inst-1', lines, 123)
    expect(r.hasIssues).toBe(true)
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].pack).toBe('ComfyUI-RMBG')
    expect(r.issues[0].missingModules).toContain('decord')
    expect(r.issues[0].summary).toContain('module_name')
    expect(r.scannedAt).toBe(123)
  })

  it('reports runtime dependency-install failures attributed to the last pack', () => {
    const lines = [
      'Lock 1 acquired on D:\\x\\custom_nodes\\ComfyUI_Custom_Nodes_AlekPet\\.install.lock',
      '* Nodes have been temporarily disabled due to the error or specially *'
    ]
    const r = parseStartupIssues('i', lines)
    expect(r.hasIssues).toBe(true)
    expect(r.issues[0].pack).toBe('ComfyUI_Custom_Nodes_AlekPet')
  })

  it('reports no issues for a clean log', () => {
    const r = parseStartupIssues('i', ['[INFO] ComfyUI ready', '[INFO] Total VRAM 16376 MB'])
    expect(r.hasIssues).toBe(false)
    expect(r.issues).toEqual([])
  })

  it('ignores ANSI codes when matching', () => {
    const r = parseStartupIssues('i', [
      '\u001b[36m[DEBUG]\u001b[0m 0.3 seconds (IMPORT FAILED): D:/x/custom_nodes/Foo'
    ])
    expect(r.issues[0].pack).toBe('Foo')
  })
})
