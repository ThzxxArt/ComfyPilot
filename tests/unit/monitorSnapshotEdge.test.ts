/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  graphics: null as any,
  cpu: null as any,
  mem: null as any,
  fsSize: null as any,
  execOut: '',
  execErr: null as Error | null,
  execCalls: [] as string[][],
  configs: [] as any[],
  remotes: [] as any[]
}))

vi.mock('systeminformation', () => ({
  default: {
    graphics: async () => {
      if (h.graphics === 'throw') throw new Error('si down')
      return h.graphics
    },
    currentLoad: async () => h.cpu,
    mem: async () => h.mem,
    fsSize: async () => h.fsSize
  }
}))

vi.mock('child_process', () => ({
  execFile: (_cmd: string, args: string[], _o: unknown, cb: any) => {
    h.execCalls.push(args)
    queueMicrotask(() => (h.execErr ? cb(h.execErr, '', '') : cb(null, h.execOut, '')))
    return { pid: 1 }
  }
}))

vi.mock('../../src/main/services/db', () => ({
  loadInstanceConfigs: () => h.configs,
  listRemotes: () => h.remotes
}))

vi.mock('ws', () => ({
  default: class {
    on(): void {}
    close(): void {}
    removeAllListeners(): void {}
  }
}))

vi.mock('../../src/main/ipc/handlers', () => ({ broadcastNotification: vi.fn() }))

import {
  MonitorService,
  assertMonitorBaseUrl,
  sampleWindowsGpuMemory
} from '../../src/main/services/monitor'

const MB = 1024 * 1024
const realPlatform = process.platform

beforeEach(() => {
  h.graphics = { controllers: [] }
  h.cpu = { currentLoad: 12.34 }
  h.mem = { total: 100, used: 40 }
  h.fsSize = [{ available: 5, size: 10 }]
  h.execOut = ''
  h.execErr = null
  h.execCalls = []
  h.configs = []
  h.remotes = []
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('monitor snapshot edge branches', () => {
  it('maps rich GPU controller fields and uses defaults for missing ones', async () => {
    h.graphics = {
      controllers: [
        {
          model: 'RTX',
          vendor: 'NVIDIA',
          vram: 8192,
          memoryUsed: 1024 * MB,
          memoryTotal: 8192 * MB,
          utilizationGpu: 55.6,
          temperatureGpu: 60.4,
          powerDraw: 120.46
        },
        { utilizationGpu: 0, powerDraw: 0 }
      ]
    }
    const svc = new MonitorService()
    const snap = await svc.systemSnapshot({ force: true })
    expect(snap.cpuUsage).toBe(12.3)
    expect(snap.ramTotal).toBe(100)
    expect(snap.gpus[0]).toMatchObject({
      model: 'RTX',
      vendor: 'NVIDIA',
      utilization: 56,
      temperature: 60,
      powerDraw: 120.5
    })
    expect(snap.gpus[1]).toMatchObject({
      model: 'Unknown GPU',
      vendor: 'unknown',
      utilization: 0
    })
    expect(snap.gpus[1].temperature).toBeUndefined()
    expect(snap.gpus[1].powerDraw).toBeUndefined()
  })

  it('falls back to the last good sample when sampling fails', async () => {
    const svc = new MonitorService()
    h.graphics = { controllers: [{ model: 'X', vram: 1024 }] }
    const first = await svc.systemSnapshot({ force: true })
    h.cpu = null
    h.mem = null
    h.fsSize = null
    h.graphics = 'throw'
    const second = await svc.systemSnapshot({ force: true })
    expect(second.cpuUsage).toBe(first.cpuUsage)
    expect(second.ramTotal).toBe(first.ramTotal)
    expect(second.gpus[0].model).toBe('X')

    const empty = new MonitorService()
    h.graphics = 'throw'
    h.cpu = null
    h.mem = null
    h.fsSize = null
    expect(await empty.systemSnapshot({ force: true })).toMatchObject({
      cpuUsage: 0,
      ramTotal: 0,
      gpus: []
    })
  })

  it('parses Windows GPU counters, caches them and tolerates failures', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const realNow = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow + 10000)
    h.execOut = ['GPU0,100,200,10,20', 'bad line', 'GPU1,not,numbers,0,0', 'GPU2,1,2,3,4', ''].join(
      '\n'
    )
    const first = await sampleWindowsGpuMemory()
    expect(first).toEqual([
      { used: 100, total: 200, sharedUsed: 10, sharedTotal: 20 },
      { used: 1, total: 2, sharedUsed: 3, sharedTotal: 4 }
    ])
    const calls = h.execCalls.length
    expect(await sampleWindowsGpuMemory()).toBe(first)
    expect(h.execCalls.length).toBe(calls)

    // After the cache window a failure returns the cached adapters.
    now.mockReturnValue(realNow + 20000)
    h.execErr = new Error('ps failed')
    expect(await sampleWindowsGpuMemory()).toEqual(first)
    now.mockRestore()
  })

  it('validates instance and remote origins for monitor URLs', () => {
    h.configs = [
      {
        id: 'i1',
        name: 'I',
        path: '/tmp/c',
        port: 8188,
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default',
        enabled: true
      }
    ]
    expect(() => assertMonitorBaseUrl('http://127.0.0.1:8188')).not.toThrow()
    expect(() => assertMonitorBaseUrl('http://10.1.2.3:8188')).toThrow(/not allowed/)
    h.remotes = [
      { id: 'bad', baseUrl: 'not a url', apiKey: 'x' },
      { id: 'r1', baseUrl: 'https://remote.example:9000', apiKey: '' }
    ]
    expect(() => assertMonitorBaseUrl('https://remote.example:9000')).not.toThrow()
    expect(() => assertMonitorBaseUrl('ftp://remote.example')).toThrow(/unsupported protocol/)
    expect(() => assertMonitorBaseUrl('not a url')).toThrow(/invalid URL/)
    expect(() => assertMonitorBaseUrl('')).toThrow(/required/)
  })
})
