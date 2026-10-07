import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import si from 'systeminformation'
import WebSocket from 'ws'
import type {
  ExecProgressEvent,
  GpuInfo,
  QueueSnapshot,
  SystemSnapshot
} from '@shared/types'
import { ComfyApiClient, COMFY_CLIENT_ID } from './comfyApi'
import { isLocalhostUrl } from './security'
import { loadInstanceConfigs, listRemotes } from './db'

/**
 * Monitor fetches/WebSockets must only target localhost or a configured
 * instance/remote origin — renderer-supplied URLs are untrusted (SSRF).
 */
export function assertMonitorBaseUrl(baseUrl: string): void {
  if (!baseUrl) throw new Error('Monitor baseUrl is required')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`Monitor: invalid URL ${baseUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Monitor: unsupported protocol ${parsed.protocol}`)
  }
  if (isLocalhostUrl(baseUrl)) return
  const origin = parsed.origin
  for (const inst of loadInstanceConfigs()) {
    const host = inst.listen === '0.0.0.0' ? '127.0.0.1' : inst.listen
    if (origin === `http://${host}:${inst.port}` || origin === `https://${host}:${inst.port}`) return
  }
  for (const remote of listRemotes()) {
    try {
      if (new URL(remote.baseUrl).origin === origin) return
    } catch {
      /* skip malformed remote */
    }
  }
  throw new Error(`Monitor: URL origin not allowed: ${origin}`)
}

export type GpuMemAdapter = { used: number; total: number }

/**
 * systeminformation often omits memoryUsed/memoryTotal on Windows
 * (nvidia-smi/NVML unavailable). Fall back to the GPU Adapter Memory
 * performance counters, which report Dedicated Usage / Limit in bytes.
 */
let gpuMemCache: { at: number; adapters: GpuMemAdapter[] } | null = null

export async function sampleWindowsGpuMemory(): Promise<GpuMemAdapter[]> {
  if (process.platform !== 'win32') return []
  const now = Date.now()
  if (gpuMemCache && now - gpuMemCache.at < 4000) return gpuMemCache.adapters
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$u=Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue",
    "$l=Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Limit' -ErrorAction SilentlyContinue",
    "$map=@{}",
    "foreach($s in @($u.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0}}; $map[$k].used=[long]$s.CookedValue }",
    "foreach($s in @($l.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0}}; $map[$k].total=[long]$s.CookedValue }",
    "$map.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Output ($_.Name + ',' + $_.Value.used + ',' + $_.Value.total) }"
  ].join('; ')
  try {
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout || ''))
      )
    })
    const adapters: GpuMemAdapter[] = []
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^.+,(\d+),(\d+)$/)
      if (!m) continue
      const used = Number(m[1])
      const total = Number(m[2])
      if (Number.isFinite(used) && Number.isFinite(total)) adapters.push({ used, total })
    }
    gpuMemCache = { at: now, adapters }
    return adapters
  } catch {
    return gpuMemCache?.adapters || []
  }
}

/** Merge controller + adapter memory into byte totals. Exported for tests. */
export function mergeGpuMemory(
  controllers: Array<{ vram?: number | null; memoryUsed?: number | null; memoryTotal?: number | null }>,
  adapters: GpuMemAdapter[]
): Array<{ vramTotal: number; vramUsed: number }> {
  const free = adapters.map((a, i) => ({ ...a, i, taken: false }))
  return controllers.map((c) => {
    const siTotal = (c.memoryTotal || 0) * 1024 * 1024
    const siUsed = (c.memoryUsed || 0) * 1024 * 1024
    const vramBytes = (c.vram || 0) * 1024 * 1024

    // Prefer explicit si values when they look real
    if (siTotal > 0 && siUsed > 0) {
      return { vramTotal: siTotal, vramUsed: Math.min(siUsed, siTotal) }
    }

    // Match a perf-counter adapter by closest dedicated limit
    let hit = free.find((a) => !a.taken && a.total > 0 && vramBytes > 0 && Math.abs(a.total - vramBytes) <= Math.max(vramBytes * 0.12, 64 * 1024 * 1024))
    if (!hit) hit = free.find((a) => !a.taken && a.total > 0)
    if (!hit) hit = free.find((a) => !a.taken && a.used > 0)
    if (hit) {
      hit.taken = true
      const total = hit.total > 0 ? hit.total : vramBytes
      const used = Math.min(Math.max(hit.used, 0), total || hit.used)
      return { vramTotal: total || vramBytes, vramUsed: used }
    }

    return { vramTotal: vramBytes, vramUsed: 0 }
  })
}

export class MonitorService extends EventEmitter {
  private last: SystemSnapshot | null = null
  private ws: WebSocket | null = null
  private wsBaseUrl = ''
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0

  /** Never rejects: partial si failures degrade instead of blowing up the tick. */
  async systemSnapshot(): Promise<SystemSnapshot> {
    try {
      const [cpu, mem, fsSize, graphics, adapters] = await Promise.all([
        si.currentLoad().catch(() => null),
        si.mem().catch(() => null),
        si.fsSize().catch(() => null),
        si.graphics().catch(() => null),
        sampleWindowsGpuMemory().catch(() => [] as GpuMemAdapter[])
      ])

      const controllers = (graphics && graphics.controllers) || []
      const memPair = mergeGpuMemory(controllers, adapters)
      const gpus: GpuInfo[] = controllers.map((c, index) => ({
        index,
        model: c.model || 'Unknown GPU',
        vendor: c.vendor || 'unknown',
        vramTotal: memPair[index]?.vramTotal || (c.vram || 0) * 1024 * 1024,
        vramUsed: memPair[index]?.vramUsed || 0,
        utilization: c.utilizationGpu || 0,
        temperature: c.temperatureGpu || undefined,
        powerDraw: (c.powerDraw || 0) > 0 ? c.powerDraw : undefined
      }))

      const root = fsSize && fsSize[0]
      const snapshot: SystemSnapshot = {
        cpuUsage: cpu ? Math.round(cpu.currentLoad * 10) / 10 : this.last?.cpuUsage ?? 0,
        ramTotal: mem?.total ?? this.last?.ramTotal ?? 0,
        ramUsed: mem?.used ?? this.last?.ramUsed ?? 0,
        diskFree: root?.available ?? this.last?.diskFree ?? 0,
        diskTotal: root?.size ?? this.last?.diskTotal ?? 0,
        gpus,
        timestamp: Date.now()
      }
      this.last = snapshot
      return snapshot
    } catch {
      return {
        cpuUsage: 0,
        ramTotal: 0,
        ramUsed: 0,
        diskFree: 0,
        diskTotal: 0,
        gpus: [],
        timestamp: Date.now()
      }
    }
  }

  getLastSnapshot(): SystemSnapshot | null {
    return this.last
  }

  async queueSnapshot(baseUrl?: string): Promise<QueueSnapshot> {
    const empty: QueueSnapshot = { running: [], pending: [], doneCount: 0, history: [] }
    if (!baseUrl) return empty
    assertMonitorBaseUrl(baseUrl)
    const client = new ComfyApiClient(baseUrl)
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/queue`, {
        signal: AbortSignal.timeout(2000)
      })
      if (!res.ok) return empty
      const data = (await res.json()) as {
        queue_running?: Array<[number, string, unknown, unknown]>
        queue_pending?: Array<[number, string, unknown, unknown]>
      }
      const history = await client.history(10)
      return {
        running: (data.queue_running || []).map((item) => {
          const promptId = Array.isArray(item) ? String(item[1] ?? item[0]) : String(item)
          return { promptId, status: 'running' as const, progress: 0 }
        }),
        pending: (data.queue_pending || []).map((item) => {
          const promptId = Array.isArray(item) ? String(item[1] ?? item[0]) : String(item)
          return { promptId, status: 'pending' as const }
        }),
        doneCount: history.length,
        history: history.map((h) => ({
          promptId: h.promptId,
          status: h.status,
          completedAt: h.completedAt
        }))
      }
    } catch {
      return empty
    }
  }

  async history(baseUrl?: string): Promise<QueueSnapshot> {
    if (baseUrl) assertMonitorBaseUrl(baseUrl)
    return this.queueSnapshot(baseUrl)
  }

  connectWs(baseUrl: string): boolean {
    assertMonitorBaseUrl(baseUrl)
    this.disconnectWs()
    this.reconnectAttempts = 0
    this.wsBaseUrl = baseUrl
    return this.openWs(baseUrl)
  }

  private openWs(baseUrl: string): boolean {
    const wsUrl = baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?clientId=' + COMFY_CLIENT_ID
    try {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      ws.on('open', () => {
        this.reconnectAttempts = 0
        this.emit('ws', { type: 'status', text: 'connected' } as ExecProgressEvent)
      })
      ws.on('message', (raw) => {
        try {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
          if (buf.length > 0 && buf[0] === 0x00) return // binary preview frame
          const msg = JSON.parse(buf.toString('utf-8')) as {
            type: string
            data?: Record<string, unknown>
          }
          const evt: ExecProgressEvent = {
            type: msg.type as ExecProgressEvent['type'],
            nodeId: msg.data?.node ? String(msg.data.node) : undefined,
            value: msg.data?.value as number | undefined,
            max: msg.data?.max as number | undefined,
            promptId: msg.data?.prompt_id ? String(msg.data.prompt_id) : undefined,
            text: msg.data?.text ? String(msg.data.text) : undefined
          }
          this.emit('ws', evt)
        } catch {
          /* ignore malformed */
        }
      })
      ws.on('close', () => {
        this.emit('ws', { type: 'status', text: 'disconnected' } as ExecProgressEvent)
        this.scheduleReconnect()
      })
      ws.on('error', () => {
        this.emit('ws', { type: 'status', text: 'error' } as ExecProgressEvent)
        this.scheduleReconnect()
      })
      return true
    } catch {
      this.scheduleReconnect()
      return false
    }
  }

  private scheduleReconnect(): void {
    if (!this.wsBaseUrl) return
    if (this.reconnectTimer) return
    // Retry forever; exponential backoff capped at 60s.
    const delay = Math.min(60000, 500 * 2 ** Math.min(this.reconnectAttempts, 10))
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.wsBaseUrl) {
        try {
          this.openWs(this.wsBaseUrl)
        } catch {
          this.scheduleReconnect()
        }
      }
    }, delay)
  }

  disconnectWs(): void {
    this.wsBaseUrl = ''
    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  isWsConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}

export const monitorService = new MonitorService()
