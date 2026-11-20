import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'

export type FakeComfyMode = 'normal' | 'hang' | 'slow' | 'close'

export interface FakeComfyOptions {
  mode?: FakeComfyMode
  /** Delay before a `slow` response is written. */
  slowMs?: number
  queueRunning?: number
  queuePending?: number
}

export interface FakeComfyServer {
  url: string
  port: number
  setMode(mode: FakeComfyMode): void
  setQueue(running: number, pending: number): void
  close(): Promise<void>
}

/**
 * Real HTTP fixture for health/monitor tests.
 * - normal: `/system_stats` + `/queue` return valid JSON
 * - hang:   TCP accepted, request never answered (blocked event loop)
 * - slow:   answers after `slowMs`
 * - close:  socket destroyed without a response
 */
export async function startFakeComfy(opts: FakeComfyOptions = {}): Promise<FakeComfyServer> {
  let mode: FakeComfyMode = opts.mode || 'normal'
  let running = opts.queueRunning ?? 0
  let pending = opts.queuePending ?? 0
  const openResponses = new Set<ServerResponse>()

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (mode === 'close') {
      req.socket.destroy()
      return
    }
    if (mode === 'hang') {
      openResponses.add(res)
      return
    }
    const write = (): void => {
      if (req.url?.startsWith('/system_stats')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            system: { comfyui_version: '0.46.0', python_version: '3.13.5' },
            devices: []
          })
        )
        return
      }
      if (req.url?.startsWith('/queue')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            queue_running: Array.from({ length: running }, (_, i) => [i, `p${i}`, {}, {}, []]),
            queue_pending: Array.from({ length: pending }, (_, i) => [i, `q${i}`, {}, {}, []])
          })
        )
        return
      }
      if (req.url?.startsWith('/features')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ flags: {} }))
        return
      }
      res.writeHead(404)
      res.end()
    }
    if (mode === 'slow') setTimeout(write, opts.slowMs ?? 3000)
    else write()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setMode(next) {
      mode = next
    },
    setQueue(r, p) {
      running = r
      pending = p
    },
    close() {
      for (const res of openResponses) {
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
      }
      openResponses.clear()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
