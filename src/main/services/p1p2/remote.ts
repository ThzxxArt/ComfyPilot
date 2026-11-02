import type { RemoteInstanceConfig, RemoteInstanceStatus } from '@shared/types'
import { listRemotes, upsertRemote, deleteRemote } from '../db'

export class RemoteService {
  list(): RemoteInstanceConfig[] {
    return listRemotes()
  }

  save(config: RemoteInstanceConfig): RemoteInstanceConfig {
    upsertRemote(config)
    return config
  }

  remove(id: string): boolean {
    return deleteRemote(id)
  }

  async test(id: string): Promise<RemoteInstanceStatus> {
    const remotes = listRemotes()
    const remote = remotes.find((r) => r.id === id)
    if (!remote) throw new Error('Remote not found')
    const headers: Record<string, string> = remote.apiKey
      ? { Authorization: `Bearer ${remote.apiKey}` }
      : {}
    try {
      const res = await fetch(`${remote.baseUrl.replace(/\/$/, '')}/system_stats`, {
        headers,
        signal: AbortSignal.timeout(4000)
      })
      if (!res.ok)
        return { id, online: false, queueRunning: 0, queuePending: 0, error: `HTTP ${res.status}` }
      let queueRunning = 0
      let queuePending = 0
      try {
        const queueRes = await fetch(`${remote.baseUrl.replace(/\/$/, '')}/queue`, {
          headers,
          signal: AbortSignal.timeout(3000)
        })
        if (queueRes.ok) {
          const queue = (await queueRes.json()) as {
            queue_running?: unknown[]
            queue_pending?: unknown[]
          }
          queueRunning = queue.queue_running?.length || 0
          queuePending = queue.queue_pending?.length || 0
        }
      } catch {
        // stats succeeded — still online even if queue is unreachable
      }
      return {
        id,
        online: true,
        queueRunning,
        queuePending
      }
    } catch (e) {
      return {
        id,
        online: false,
        queueRunning: 0,
        queuePending: 0,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  async listStatus(): Promise<RemoteInstanceStatus[]> {
    const remotes = listRemotes().filter((r) => r.enabled)
    return Promise.all(remotes.map((r) => this.test(r.id)))
  }
}

export const remoteService = new RemoteService()
