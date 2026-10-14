/**
 * Runtime execution-error parser (0.1.12) — real-log fixtures.
 * The primary fixture mirrors the reported PathchSageAttentionKJ failure
 * (ComfyUI 0.40: `[ERROR] !!! Exception during processing !!!` banner +
 * traceback block), plus a prefix-free legacy variant.
 */
import { describe, it, expect } from 'vitest'
import { parseExecErrors, formatExecErrorReport, stripAnsi } from '../../src/shared/execError'
import type { ComfyLogLine } from '../../src/shared/types'

const T0 = Date.parse('2026-10-14T21:19:11.000Z')

function line(tsOffset: number, message: string): ComfyLogLine {
  return { ts: T0 + tsOffset, level: 'error', message, source: 'comfy' }
}

const REAL_BLOCK: ComfyLogLine[] = [
  line(0, 'got prompt'),
  line(500, 'Using sage attention mode: auto'),
  line(1000, "[ERROR] !!! Exception during processing !!! No module named 'sageattention'"),
  line(1001, '[ERROR] Traceback (most recent call last):'),
  line(
    1002,
    '  File "D:\\ComfyPilotRuntimes\\comfy-main\\ComfyUI\\execution.py", line 548, in execute'
  ),
  line(
    1003,
    '    output_data, output_ui, has_subgraph, has_pending_tasks = await get_output_data(prompt_id, unique_id, obj, input_data_all)'
  ),
  line(
    1004,
    '  File "D:\\ComfyPilotRuntimes\\comfy-main\\ComfyUI\\custom_nodes\\ComfyUI-KJNodes\\nodes\\model_optimization_nodes.py", line 31, in get_sage_func'
  ),
  line(1005, '    from sageattention import sageattn'),
  line(1006, "[ERROR] ModuleNotFoundError: No module named 'sageattention'"),
  line(1500, '[DETAIL] RAM cache evictions: prompt=9a46 active=False full=False'),
  line(1600, '[INFO] Prompt executed in 1.60 seconds')
]

describe('parseExecErrors (0.1.12)', () => {
  it('parses the real PathchSageAttentionKJ failure: type, module, pack attribution', () => {
    const out = parseExecErrors(REAL_BLOCK)
    expect(out).toHaveLength(1)
    const e = out[0]
    expect(e.errorType).toBe('ModuleNotFoundError')
    expect(e.message).toBe("No module named 'sageattention'")
    expect(e.missingModule).toBe('sageattention')
    expect(e.packFolder).toBe('ComfyUI-KJNodes')
    expect(e.at).toBe(T0 + 1000)
    // `[INFO] Prompt executed` ends the block — no trailing junk.
    expect(e.traceback.join('\n')).not.toContain('Prompt executed')
  })

  it('handles a prefix-free legacy traceback (old ComfyUI versions)', () => {
    const legacy: ComfyLogLine[] = [
      line(0, '!!! Exception during processing !!! something exploded'),
      line(10, 'Traceback (most recent call last):'),
      line(20, '  File "C:\\ComfyUI\\execution.py", line 353, in get_output_data'),
      line(30, 'RuntimeError: something exploded')
    ]
    const out = parseExecErrors(legacy)
    expect(out).toHaveLength(1)
    expect(out[0].errorType).toBe('RuntimeError')
    expect(out[0].message).toBe('something exploded')
    expect(out[0].missingModule).toBeUndefined()
    expect(out[0].packFolder).toBeUndefined()
  })

  it('parses non-module errors without inventing a missing module', () => {
    const logs: ComfyLogLine[] = [
      line(0, '!!! Exception during processing !!! CUDA out of memory'),
      line(10, 'torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 8.00 GiB')
    ]
    const out = parseExecErrors(logs)
    expect(out[0].errorType).toBe('torch.cuda.OutOfMemoryError')
    expect(out[0].message).toContain('CUDA out of memory')
    expect(out[0].missingModule).toBeUndefined()
  })

  it('parses multiple failures in one slice and stops at wall-clock gaps', () => {
    const logs: ComfyLogLine[] = [
      line(0, '!!! Exception during processing !!! first'),
      line(10, 'ValueError: first'),
      line(60_000, '!!! Exception during processing !!! second'),
      line(60_010, 'TypeError: second')
    ]
    const out = parseExecErrors(logs)
    expect(out).toHaveLength(2)
    expect(out[0].errorType).toBe('ValueError')
    expect(out[1].errorType).toBe('TypeError')
  })

  it('strips ANSI colour codes before matching', () => {
    const logs: ComfyLogLine[] = [
      line(
        0,
        '\u001b[31m[ERROR]\u001b[0m !!! Exception during processing !!! \u001b[31mboom\u001b[0m'
      ),
      line(10, '\u001b[31mKeyError: boom\u001b[0m')
    ]
    const out = parseExecErrors(logs)
    expect(out).toHaveLength(1)
    expect(out[0].errorType).toBe('KeyError')
    expect(stripAnsi('\u001b[32mok\u001b[0m')).toBe('ok')
  })

  it('uses the trigger tail when no exception line exists', () => {
    const logs: ComfyLogLine[] = [
      line(0, "!!! Exception during processing !!! No module named 'triton'"),
      line(10, '[INFO] Prompt executed in 0.1 seconds')
    ]
    const out = parseExecErrors(logs)
    expect(out[0].errorType).toBe('Exception')
    expect(out[0].missingModule).toBe('triton')
  })

  it('formats a human-readable failure report', () => {
    const e = parseExecErrors(REAL_BLOCK)[0]
    const report = formatExecErrorReport({
      ...e,
      nodeType: 'PathchSageAttentionKJ',
      nodeId: '48',
      promptId: 'p-1'
    })
    expect(report).toContain('Missing module: sageattention')
    expect(report).toContain('Custom node pack: ComfyUI-KJNodes')
    expect(report).toContain('Node: PathchSageAttentionKJ (id 48)')
    expect(report).toContain('--- traceback ---')
  })
})
