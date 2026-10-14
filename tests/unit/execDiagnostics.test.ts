/**
 * ExecDiagnosticsService (0.1.12) — WS failure recording, log-tail parsing,
 * dedupe/merge, dismissal and the notify throttle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  logs: [] as Array<{ ts: number; level: string; message: string; source?: string }>
}))

vi.mock('../../src/main/services/instance', () => ({
  instanceService: {
    getLogs: () => h.logs
  }
}))

vi.mock('../../src/main/services/capabilities', () => ({
  capabilityService: {
    pythonModuleForTypeCached: (_id: string, type: string) =>
      type === 'PathchSageAttentionKJ' ? 'ComfyUI-KJNodes' : undefined
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => [{ id: 'i1', listen: '127.0.0.1', port: 8188 }]
}))

const T0 = 1_700_000_000_000

function errEvent(over: Record<string, unknown> = {}): any {
  return {
    type: 'execution_error',
    nodeId: '48',
    nodeType: 'PathchSageAttentionKJ',
    promptId: 'p-1',
    errorType: 'ModuleNotFoundError',
    errorMessage: "No module named 'sageattention'",
    errorTraceback: ['Traceback (most recent call last):', 'ModuleNotFoundError'],
    baseUrl: 'http://127.0.0.1:8188',
    ...over
  }
}

describe('ExecDiagnosticsService (0.1.12)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    vi.resetModules()
    h.logs = []
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function fresh(): Promise<any> {
    return (await import('../../src/main/services/execDiagnostics')).execDiagnosticsService
  }

  it('maps monitor base URLs to instance ids (localhost origins only)', async () => {
    const svc = await fresh()
    expect(svc.instanceIdForBaseUrl('http://127.0.0.1:8188')).toBe('i1')
    expect(svc.instanceIdForBaseUrl('http://127.0.0.1:9999')).toBeUndefined()
    expect(svc.instanceIdForBaseUrl('nonsense')).toBeUndefined()
  })

  it('records WS failures with extracted missing module + emits failure/notify once', async () => {
    const svc = await fresh()
    const failures: any[] = []
    const notifies: any[] = []
    svc.on('failure', (f: any) => failures.push(f))
    svc.on('notify', (f: any) => notifies.push(f))

    svc.recordWs('i1', errEvent())
    expect(failures).toHaveLength(1)
    expect(failures[0].missingModule).toBe('sageattention')
    expect(failures[0].nodeType).toBe('PathchSageAttentionKJ')

    // Same error within the dedupe window → failure event but no second notify.
    vi.setSystemTime(T0 + 1000)
    svc.recordWs('i1', errEvent({ promptId: 'p-2' }))
    expect(failures).toHaveLength(2)
    expect(notifies).toHaveLength(1)

    // Different message → new notify after the window too.
    vi.setSystemTime(T0 + 11_000)
    svc.recordWs('i1', errEvent({ errorMessage: 'CUDA out of memory', errorType: 'OOM' }))
    expect(notifies).toHaveLength(2)
  })

  it('ignores non-error events', async () => {
    const svc = await fresh()
    expect(svc.recordWs('i1', { type: 'status', baseUrl: 'x' } as any)).toBeNull()
  })

  it('parses the log tail on debounced trigger and lists merged failures', async () => {
    const svc = await fresh()
    h.logs = [
      { ts: T0, level: 'error', message: '[INFO] got prompt', source: 'comfy' },
      {
        ts: T0 + 100,
        level: 'error',
        message: "[ERROR] !!! Exception during processing !!! No module named 'triton'",
        source: 'comfy'
      },
      {
        ts: T0 + 110,
        level: 'error',
        message: '[ERROR] Traceback (most recent call last):',
        source: 'comfy'
      },
      {
        ts: T0 + 120,
        level: 'error',
        message:
          '  File "C:\\ComfyUI\\custom_nodes\\ComfyUI-RMBG\\models\\edt.py", line 6, in <module>',
        source: 'comfy'
      },
      {
        ts: T0 + 130,
        level: 'error',
        message: "[ERROR] ModuleNotFoundError: No module named 'triton'",
        source: 'comfy'
      },
      {
        ts: T0 + 200,
        level: 'info',
        message: '[INFO] Prompt executed in 1.00 seconds',
        source: 'comfy'
      }
    ]
    svc.noteLogLine('i1', "[ERROR] !!! Exception during processing !!! No module named 'triton'")
    // Debounce: nothing parsed before the window elapses.
    expect(svc.list('i1')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(600)
    const list = svc.list('i1')
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('log')
    expect(list[0].missingModule).toBe('triton')
    expect(list[0].packFolder).toBe('ComfyUI-RMBG')
    expect(list[0].errorType).toBe('ModuleNotFoundError')

    // A second rescan must not duplicate the same failure.
    svc.rescanLogs('i1')
    expect(svc.list('i1')).toHaveLength(1)
  })

  it('drops log duplicates of a WS failure and enriches pack attribution when possible', async () => {
    const svc = await fresh()
    svc.recordWs('i1', errEvent())
    h.logs = [
      {
        ts: T0,
        level: 'error',
        message: "[ERROR] !!! Exception during processing !!! No module named 'sageattention'",
        source: 'comfy'
      },
      {
        ts: T0 + 5,
        level: 'error',
        message: "[ERROR] ModuleNotFoundError: No module named 'sageattention'",
        source: 'comfy'
      }
    ]
    svc.rescanLogs('i1')
    const list = svc.list('i1')
    // WS entry wins (richer), log duplicate suppressed.
    expect(list).toHaveLength(1)
    expect(list[0].source).toBe('ws')
    // Late attribution via the (mocked) object_info cache.
    expect(list[0].packFolder).toBe('ComfyUI-KJNodes')
  })

  it('clear() dismisses existing failures and keeps them dismissed on rescan', async () => {
    const svc = await fresh()
    svc.recordWs('i1', errEvent())
    expect(svc.list('i1')).toHaveLength(1)
    svc.clear('i1')
    expect(svc.list('i1')).toHaveLength(0)

    // Old log lines stay dismissed…
    h.logs = [
      {
        ts: T0 - 1000,
        level: 'error',
        message: "[ERROR] !!! Exception during processing !!! No module named 'sageattention'",
        source: 'comfy'
      },
      {
        ts: T0 - 900,
        level: 'error',
        message: "[ERROR] ModuleNotFoundError: No module named 'sageattention'",
        source: 'comfy'
      }
    ]
    svc.rescanLogs('i1')
    expect(svc.list('i1')).toHaveLength(0)

    // …while a NEW failure after clearing surfaces.
    vi.setSystemTime(T0 + 5000)
    h.logs.push({
      ts: T0 + 5000,
      level: 'error',
      message: "!!! Exception during processing !!! No module named 'triton'",
      source: 'comfy'
    })
    h.logs.push({
      ts: T0 + 5010,
      level: 'error',
      message: "ModuleNotFoundError: No module named 'triton'",
      source: 'comfy'
    })
    svc.rescanLogs('i1')
    const fresh2 = svc.list('i1')
    expect(fresh2).toHaveLength(1)
    expect(fresh2[0].missingModule).toBe('triton')
  })

  it('ignores stale failure blocks in the log history (restart-safe, 0.1.12)', async () => {
    const svc = await fresh()
    // A failure from ~10 minutes ago (its in-memory record would be gone
    // after an app restart) plus a fresh one just now: only the fresh one may
    // surface — stale history must not "resurrect" and re-notify.
    h.logs = [
      {
        ts: T0 - 600_000,
        level: 'error',
        message: "!!! Exception during processing !!! No module named 'old'",
        source: 'comfy'
      },
      {
        ts: T0 - 599_990,
        level: 'error',
        message: "ModuleNotFoundError: No module named 'old'",
        source: 'comfy'
      },
      {
        ts: T0,
        level: 'error',
        message: "!!! Exception during processing !!! No module named 'fresh'",
        source: 'comfy'
      },
      {
        ts: T0 + 5,
        level: 'error',
        message: "ModuleNotFoundError: No module named 'fresh'",
        source: 'comfy'
      }
    ]
    svc.rescanLogs('i1')
    const list = svc.list('i1')
    expect(list).toHaveLength(1)
    expect(list[0].missingModule).toBe('fresh')
  })

  it('caps stored failures at 20 per instance', async () => {
    const svc = await fresh()
    for (let i = 0; i < 25; i++) {
      vi.setSystemTime(T0 + i * 20_000)
      svc.recordWs('i1', errEvent({ errorMessage: `boom ${i}` }))
    }
    expect(svc.list('i1').length).toBeLessThanOrEqual(20)
  })
})
