import { execFile } from 'child_process'
import { promisify } from 'util'
import type { AttentionSelfTestResult } from '@shared/types'
import {
  ATTENTION_SELF_TEST_SCRIPT,
  emptyAttentionSelfTest,
  parseAttentionSelfTest
} from '@shared/attentionSelfTest'
import { loadInstanceConfigs } from '../db'
import type { InstanceServiceContext } from './types'

const execFileAsync = promisify(execFile)

/**
 * Run the fixed attention self-test in the instance's own venv.
 *
 * Only the instance id crosses IPC; the script is a compile-time constant. A
 * non-zero exit still returns the parsed stdout when the script managed to
 * print a result, so a failed kernel is visible instead of collapsing into a
 * generic spawn error.
 */
export async function selfTest(
  ctx: InstanceServiceContext,
  id: string
): Promise<AttentionSelfTestResult> {
  const config = loadInstanceConfigs().find((c) => c.id === id)
  if (!config) return emptyAttentionSelfTest(`Instance not found: ${id}`)
  const pythonPath = ctx.resolvePython(config)
  try {
    const result = (await execFileAsync(pythonPath, ['-c', ATTENTION_SELF_TEST_SCRIPT], {
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024
    })) as unknown as { stdout?: string } | string
    const stdout = typeof result === 'string' ? result : result.stdout || ''
    return parseAttentionSelfTest(stdout)
  } catch (err) {
    const e = err as { message?: string; stdout?: string }
    const fallback = e.message || String(err)
    return parseAttentionSelfTest(e.stdout || '', Date.now(), fallback)
  }
}
