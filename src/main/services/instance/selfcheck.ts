import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { InstanceStartupIssues } from '@shared/types'
import { comfyChildEnv } from '../childEnv'
import { parseStartupIssues } from '../startupIssues'
import { loadInstanceConfigs, loadSettings } from '../db'
import type { InstanceServiceContext } from './types'

/**
 * One-shot boot self-check (0.1.10): runs ComfyUI with `--quick-test-for-ci
 * --cpu` — ComfyUI loads every custom node and exits.
 * Output lines are streamed into the instance log VERBATIM (no prefix):
 * the "Import times for custom nodes" block must stay byte-compatible with
 * a real boot log so `node.loadReport` can parse it afterwards.
 */
export async function runStartupSelfCheck(
  ctx: InstanceServiceContext,
  id: string
): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  const config = loadInstanceConfigs().find((c) => c.id === id)
  if (!config) throw new Error(`Instance not found: ${id}`)
  const rt = ctx.ensureRuntime(config)
  const running = Boolean(rt.process && rt.process.exitCode === null)
  if (!existsSync(join(config.path, 'main.py'))) {
    throw new Error(`main.py not found under ${config.path}`)
  }
  const python = ctx.resolvePython(config)
  // 0.1.11: a running instance no longer blocks the self-check. The runner
  // keeps its port and GPU; the check loads nodes on CPU with
  // --quick-test-for-ci on an ephemeral port and exits. Only the user/db
  // files are shared (same trade-off ComfyUI makes for concurrent runs).
  const args = [join(config.path, 'main.py'), '--quick-test-for-ci', '--cpu']
  if (running) {
    const port = await ctx.pickEphemeralPort(config.port || 8188)
    args.push('--port', String(port))
  }
  ctx.pushLog(rt, 'info', '=== ComfyPilot selfcheck start ===')
  ctx.pushLog(
    rt,
    'info',
    running
      ? `Startup self-check (instance keeps running; check uses its own port): ${[python, ...args].join(' ')}`
      : `Startup self-check: ${[python, ...args].join(' ')}`
  )
  const result = await new Promise<{ ok: boolean; exitCode: number | null; output: string }>(
    (resolveP) => {
      execFile(
        python,
        args,
        {
          cwd: config.path,
          timeout: 180_000,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
          env: comfyChildEnv(loadSettings())
        },
        (err, stdout, stderr) => {
          const output = `${stdout || ''}${stderr || ''}`
          const rawCode = err ? (err as { code?: number | string }).code : 0
          const exitCode = typeof rawCode === 'number' ? rawCode : err ? 1 : 0
          resolveP({ ok: !err, exitCode, output })
        }
      )
    }
  )
  for (const line of result.output.split(/\r?\n/)) {
    if (!line.trim()) continue
    ctx.pushLog(rt, /error|traceback|failed/i.test(line) ? 'error' : 'info', line)
  }
  ctx.pushLog(
    rt,
    result.ok ? 'info' : 'error',
    result.ok ? 'Startup self-check passed' : `Startup self-check failed (exit ${result.exitCode})`
  )
  ctx.pushLog(rt, 'info', '=== ComfyPilot selfcheck end ===')
  return result
}

/**
 * Custom-node packs that failed to import, parsed from the instance log
 * (0.1.16). Read-only — the UI decides whether to offer a dependency fix.
 */
export function analyzeStartupIssues(
  ctx: InstanceServiceContext,
  id: string
): InstanceStartupIssues {
  const all = ctx.getLogs(id, 3000).map((l) => l.message)
  // 0.2.0: only the LAST real boot counts. Without this, an old
  // `IMPORT FAILED` stayed visible forever across restarts and app launches.
  let bootAt = -1
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].includes('=== ComfyPilot boot ')) {
      bootAt = i
      break
    }
  }
  if (bootAt < 0) {
    return { instanceId: id, hasIssues: false, issues: [], scannedAt: Date.now() }
  }
  const bootId = (all[bootAt].match(/=== ComfyPilot boot (\S+)/) || [])[1]
  // Self-check emits its own Import-times block; it must not be attributed to
  // the running instance.
  const lines: string[] = []
  let inSelfCheck = false
  for (const line of all.slice(bootAt + 1)) {
    if (line.includes('=== ComfyPilot selfcheck start ===')) {
      inSelfCheck = true
      continue
    }
    if (line.includes('=== ComfyPilot selfcheck end ===')) {
      inSelfCheck = false
      continue
    }
    if (!inSelfCheck) lines.push(line)
  }
  return { ...parseStartupIssues(id, lines), bootId }
}
