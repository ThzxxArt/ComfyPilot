/** Stable client id so WS progress events match queued prompts. */
export const COMFY_CLIENT_ID = 'comfy-pilot'

/** Lightweight ComfyUI HTTP helper used by monitor + batch + embed. */
export class ComfyApiClient {
  constructor(private baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  async systemStats(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(this.url('/system_stats'), { signal: AbortSignal.timeout(1500) })
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async objectInfo(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(this.url('/object_info'), { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async queuePrompt(
    prompt: Record<string, unknown>,
    clientId: string
  ): Promise<string | null> {
    try {
      const res = await fetch(this.url('/prompt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, client_id: clientId }),
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) return null
      const data = (await res.json()) as { prompt_id?: string }
      return data.prompt_id || null
    } catch {
      return null
    }
  }

  async history(limit = 20): Promise<
    Array<{ promptId: string; status: string; completedAt?: number }>
  > {
    try {
      const res = await fetch(this.url('/history?max_items=' + limit), {
        signal: AbortSignal.timeout(2000)
      })
      if (!res.ok) return []
      const data = (await res.json()) as Record<string, Record<string, unknown>>
      return Object.entries(data).map(([promptId, v]) => {
        // ComfyUI history has no completed_at; use status_str + last exec message timestamp.
        const st = v?.status as
          | {
              status_str?: string
              completed?: boolean
              messages?: Array<[string, Record<string, unknown>?]>
            }
          | undefined
        const statusStr = typeof st?.status_str === 'string' ? st.status_str : undefined
        const status = statusStr || (st?.completed ? 'success' : 'unknown')
        let completedAt: number | undefined
        for (const msg of st?.messages || []) {
          const [type, payload] = Array.isArray(msg) ? msg : [String(msg), undefined]
          if (type === 'execution_success' || type === 'execution_error') {
            const ts = Number(payload?.timestamp)
            if (Number.isFinite(ts) && ts > 0) completedAt = ts
          }
        }
        return { promptId, status, completedAt }
      })
    } catch {
      return []
    }
  }

  async interrupt(): Promise<boolean> {
    try {
      const res = await fetch(this.url('/interrupt'), { method: 'POST' })
      return res.ok
    } catch {
      return false
    }
  }
}
