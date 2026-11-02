import { describe, expect, it } from 'vitest'
import { parseStartupIssues } from '../../src/main/services/startupIssues'

describe('parseStartupIssues (0.2.0 boot session)', () => {
  it('attributes failures for pack names containing spaces', () => {
    const result = parseStartupIssues('i1', [
      'Traceback (most recent call last):',
      '  File "D:/ComfyUI/custom_nodes/My Pack/__init__.py", line 1, in <module>',
      "ModuleNotFoundError: No module named 'requests'"
    ])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].pack).toBe('My Pack')
    expect(result.issues[0].missingModules).toEqual(['requests'])
  })

  it('ignores bare optional-module probes without a failure anchor', () => {
    const result = parseStartupIssues('i1', [
      "[INFO] torch_npu not available: No module named 'torch_npu'",
      '[INFO] No OpenGL_accelerate module loaded'
    ])
    expect(result.issues).toEqual([])
    expect(result.hasIssues).toBe(false)
  })

  it('keeps optional imports out of the hard-missing list', () => {
    const result = parseStartupIssues('i1', [
      'Traceback (most recent call last):',
      '  File "C:/ComfyUI/custom_nodes/Foo/__init__.py", line 1, in <module>',
      "ModuleNotFoundError: No module named 'torch_npu'"
    ])
    expect(result.issues[0].missingModules).toEqual([])
    expect(result.issues[0].optionalModules).toEqual(['torch_npu'])
  })

  it('recognises PRESTARTUP FAILED and resets attribution at a new section', () => {
    const result = parseStartupIssues('i1', [
      'Prestartup times for custom nodes:',
      '  0.1 seconds (PRESTARTUP FAILED): C:/ComfyUI/custom_nodes/Pre',
      'Import times for custom nodes:',
      '  0.2 seconds: C:/ComfyUI/custom_nodes/Ok'
    ])
    expect(result.issues.map((i) => i.pack)).toEqual(['Pre'])
  })
})
