import { describe, it, expect } from 'vitest'
import { parseStartupIssues, packFromCustomNodesPath } from '../../src/main/services/startupIssues'

describe('startupIssues (0.1.16)', () => {
  it('extracts a pack folder from a custom_nodes path', () => {
    expect(packFromCustomNodesPath('File "D:/x/custom_nodes/ComfyUI-RMBG/py/a.py", line 3')).toBe(
      'ComfyUI-RMBG'
    )
    expect(packFromCustomNodesPath('nothing here')).toBeNull()
    expect(packFromCustomNodesPath('')).toBeNull()
    expect(packFromCustomNodesPath(undefined as unknown as string)).toBeNull()
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

  it('treats a node-level missing accelerator as optional when the pack loaded', () => {
    const r = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\ComfyUI-KJNodes',
      '[WARNING] KJNodes: PatchTritonVAE node could not be imported. PatchTritonVAE will be unavailable.',
      'Traceback (most recent call last):',
      '  File "D:\\x\\custom_nodes\\ComfyUI-KJNodes\\nodes\\triton_vae.py", line 11, in <module>',
      '    import triton',
      "ModuleNotFoundError: No module named 'triton'",
      'Import times for custom nodes:',
      '    0.0 seconds: D:\\x\\custom_nodes\\ComfyUI-KJNodes'
    ])
    // The pack loaded; only the optional PatchTritonVAE node is unavailable.
    expect(r.hasIssues).toBe(false)
    expect(r.issues).toEqual([])
  })

  it('keeps a missing module hard when the pack never imported', () => {
    const r = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\BrokenPack',
      'Traceback (most recent call last):',
      '  File "D:\\x\\custom_nodes\\BrokenPack\\__init__.py", line 2, in <module>',
      "ModuleNotFoundError: No module named 'onnx'",
      '0.4 seconds (IMPORT FAILED): D:\\x\\custom_nodes\\BrokenPack'
    ])
    expect(r.hasIssues).toBe(true)
    expect(r.issues[0].pack).toBe('BrokenPack')
    expect(r.issues[0].missingModules).toEqual(['onnx'])
    expect(r.issues[0].optionalModules || []).toEqual([])
  })

  it('does not credit the previous pack traceback to the next pack warning', () => {
    const r = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\BrokenA',
      'Traceback (most recent call last):',
      '  File "D:\\x\\custom_nodes\\BrokenA\\__init__.py", line 2, in <module>',
      "ModuleNotFoundError: No module named 'decord'",
      'Trying to load custom node D:\\x\\custom_nodes\\HealthyB',
      "[WARNING] HealthyB: optional node not available: No module named 'triton'",
      'Import times for custom nodes:',
      '    0.1 seconds: D:\\x\\custom_nodes\\HealthyB'
    ])
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].pack).toBe('BrokenA')
    expect(r.issues[0].missingModules).toEqual(['decord'])
    expect(r.issues.some((issue) => issue.pack === 'HealthyB')).toBe(false)
  })

  it('downgrades every leftover hard module for a pack listed as imported', () => {
    const r = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\ComfyUI-RMBG',
      'Traceback (most recent call last):',
      '  File "D:\\x\\custom_nodes\\ComfyUI-RMBG\\nodes.py", line 7, in <module>',
      "ModuleNotFoundError: No module named 'onnx'",
      'Import times for custom nodes:',
      '    0.2 seconds: D:\\x\\custom_nodes\\ComfyUI-RMBG'
    ])
    expect(r.hasIssues).toBe(false)
  })

  it('closes the import-times block on the next non-time line', () => {
    const r = parseStartupIssues('i', [
      '',
      'Import times for custom nodes:',
      '    0.0 seconds: D:\\x\\custom_nodes\\Loaded',
      'Some unrelated log line',
      '    0.1 seconds: D:\\x\\custom_nodes\\NotLoaded',
      'Trying to load custom node D:\\x\\custom_nodes\\NotLoaded',
      'Traceback (most recent call last):',
      '  File "D:\\x\\custom_nodes\\NotLoaded\\__init__.py", line 1',
      "ModuleNotFoundError: No module named 'decord'"
    ])
    // `NotLoaded` appears after the block ended, so it is not treated as
    // loaded and its missing module stays a real failure.
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].pack).toBe('NotLoaded')
    expect(r.issues[0].missingModules).toEqual(['decord'])
  })

  it('keeps the last pack when a non-pack "Trying to load" line appears', () => {
    const r = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\PackA',
      'Traceback (most recent call last):',
      '  File "D:\\x\\custom_nodes\\PackA\\__init__.py", line 1',
      "ModuleNotFoundError: No module named 'decord'",
      'Trying to load custom node D:\\x\\ComfyUI\\comfy_extras\\nodes_latent.py',
      '',
      "ModuleNotFoundError: No module named 'ignored-after-reset'"
    ])
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].pack).toBe('PackA')
    expect(r.issues[0].missingModules).toEqual(['decord'])
  })

  it('attributes IMPORT FAILED to lastPack or unknown when the path is not a pack', () => {
    const withLast = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\PackA',
      '0.4 seconds (IMPORT FAILED): D:\\x\\somewhere-else'
    ])
    expect(withLast.issues[0].pack).toBe('PackA')

    const noLast = parseStartupIssues('i', ['0.4 seconds (IMPORT FAILED): D:\\x\\somewhere-else'])
    expect(noLast.issues[0].pack).toBe('unknown')
    expect(noLast.issues[0].summary).toBe('Import failed')
  })

  it('handles Cannot import without a pack path and with an empty reason', () => {
    const withLast = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\PackA',
      'Cannot import some-module module for custom nodes: '
    ])
    expect(withLast.issues[0].pack).toBe('PackA')
    expect(withLast.issues[0].summary).toBe('Import failed')

    const noLast = parseStartupIssues('i', ['Cannot import some-module module for custom nodes: '])
    expect(noLast.issues[0].pack).toBe('unknown')
  })

  it('attributes a disabled-nodes line to unknown when no pack was seen', () => {
    const r = parseStartupIssues('i', [
      '* Nodes have been temporarily disabled due to the error or specially *'
    ])
    expect(r.issues[0].pack).toBe('unknown')
  })

  it('keeps prestartup-only packs out of the loaded set', () => {
    const r = parseStartupIssues('i', [
      'Trying to load custom node D:\\x\\custom_nodes\\PreOnly',
      'Traceback (most recent call last):',
      '  File "D:\\x\\custom_nodes\\PreOnly\\__init__.py", line 2, in <module>',
      "ModuleNotFoundError: No module named 'torch_npu'",
      'Prestartup times for custom nodes:',
      '    0.1 seconds: D:\\x\\custom_nodes\\PreOnly'
    ])
    // torch_npu is a known platform-optional accelerator, so it is dropped
    // even though the pack is not in the import-times block.
    expect(r.hasIssues).toBe(false)
  })
})
