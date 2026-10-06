import { EventEmitter } from 'events'
import si from 'systeminformation'
import WebSocket from 'ws'
import type {
  ExecProgressEvent,
  GpuInfo,
  QueueSnapshot,
  SystemSnapshot
} from '@shared/types'
import { ComfyApiClient } from './comfyApi'

export class MonitorService extends EventEmitter {
  private last: SystemSnapshot | null = null
  private ws: WebSocket | null = null

  async systemSnapshot(): Promise<SystemSnapshot> {
    const [cpu, mem, fsSize, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.graphics()
    ])

    const gpus: GpuInfo[] = (graphics.controllers || []).map((c, index) => ({
      index,
      model: c.model || 'Unknown GPU',
      vendor: c.vendor || 'unknown',
      vramTotal: (c.vram || 0) * 1024 * 1024,
      vramUsed: (c.memoryUsed || 0) > 0 ? (c.memoryUsed || 0) * 1024 * 1024 : 0,
      utilization: c.utilizationGpu || 0,
      temperature: c.temperatureGpu || undefined,
      powerDraw: (c.powerDraw || 0) > 0 ? c.powerDraw : undefined
    }))

    const root = fsSize[0]
    const snapshot: SystemSnapshot = {
      cpuUsage: Math.round(cpu.currentLoad * 10) / 10,
      ramTotal: mem.total,
      ramUsed: mem.used,
      diskFree: root?.available || 0,
      diskTotal: root?.size || 0,
      gpus,
      timestamp: Date.now()
    }
    this.last = snapshot
    return snapshot
  }

  getLastSnapshot(): SystemSnapshot | null {
    return this.last
  }

  async queueSnapshot(baseUrl?: string): Promise<QueueSnapshot> {
    const empty: QueueSnapshot = { running: [], pending: [], doneCount: 0, history: [] }
    if (!baseUrl) return empty
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
        running: (data.queue_running || []).map(([id]) => ({
          promptId: String(id),
          status: 'running' as const,
          progress: 0
        })),
        pending: (data.queue_pending || []).map(([id]) => ({
          promptId: String(id),
          status: 'pending' as const
        })),
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
    return this.queueSnapshot(baseUrl)
  }

  connectWs(baseUrl: string): boolean {
    this.disconnectWs()
    const wsUrl = baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?clientId=comfy-pilot'
    try {
      const ws = new WebSocket(wsUrl)
      this.ws = ws
      ws.on('open', () => this.emit('ws', { type: 'status', text: 'connected' } as ExecProgressEvent))
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
      ws.on('close', () => this.emit('ws', { type: 'status', text: 'disconnected' } as ExecProgressEvent))
      ws.on('error', () => this.emit('ws', { type: 'status', text: 'error' } as ExecProgressEvent))
      return true
    } catch {
      return false
    }
  }

  disconnectWs(): void {
    if (this.ws) {
      try {
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
