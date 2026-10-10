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
      if (!res.ok) {
        // Surface ComfyUI's error body so callers can report WHY queueing failed.
        const text = await res.text().catch(() => '')
        let detail = text.slice(0, 500)
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string; details?: string }; node_errors?: Record<string, unknown> }
          const msg = parsed.error?.message || parsed.error?.details
          if (msg) detail = msg
          else if (parsed.node_errors && Object.keys(parsed.node_errors).length) {
            detail = `node errors: ${Object.keys(parsed.node_errors).join(', ')}`
          }
        } catch {
          /* keep raw text */
        }
        throw new Error(`ComfyUI rejected prompt (HTTP ${res.status}): ${detail || 'no detail'}`)
      }
      const data = (await res.json()) as { prompt_id?: string }
      return data.prompt_id || null
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('ComfyUI rejected prompt')) throw err
      throw new Error(`queuePrompt failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Point lookup — keeps prompts visible after they fall out of the rolling window. */
  async historyItem(promptId: string): Promise<{
    promptId: string
    status: string
    completedAt?: number
    outputs: Array<{ filename: string; subfolder: string; type: string }>
  } | null> {
    if (!promptId) return null
    try {
      const res = await fetch(this.url(`/history/${encodeURIComponent(promptId)}`), {
        signal: AbortSignal.timeout(3000)
      })
      if (!res.ok) return null
      const data = (await res.json()) as Record<string, Record<string, unknown>>
      const entry = data[promptId]
      if (!entry) return null
      const list = this.parseHistoryEntries({ [promptId]: entry })
      return list[0] || null
    } catch {
      return null
    }
  }

  private parseHistoryEntries(data: Record<string, Record<string, unknown>>): Array<{
    promptId: string
    status: string
    completedAt?: number
    outputs: Array<{ filename: string; subfolder: string; type: string }>
  }> {
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
      // Collect SaveImage / SaveVideo style outputs for batch→output linking.
      const outputs: Array<{ filename: string; subfolder: string; type: string }> = []
      const outMap = v?.outputs as Record<string, Record<string, unknown>> | undefined
      if (outMap && typeof outMap === 'object') {
        for (const nodeOut of Object.values(outMap)) {
          for (const key of ['images', 'gifs', 'videos', 'audio']) {
            const arr = nodeOut?.[key]
            if (!Array.isArray(arr)) continue
            for (const item of arr) {
              const o = item as { filename?: string; subfolder?: string; type?: string }
              if (o?.filename) {
                outputs.push({
                  filename: String(o.filename),
                  subfolder: String(o.subfolder || ''),
                  type: String(o.type || 'output')
                })
              }
            }
          }
        }
      }
      return { promptId, status, completedAt, outputs }
    })
  }

  async history(limit = 20): Promise<
    Array<{
      promptId: string
      status: string
      completedAt?: number
      outputs: Array<{ filename: string; subfolder: string; type: string }>
    }>
  > {
    try {
      const res = await fetch(this.url('/history?max_items=' + limit), {
        signal: AbortSignal.timeout(2000)
      })
      if (!res.ok) return []
      const data = (await res.json()) as Record<string, Record<string, unknown>>
      return this.parseHistoryEntries(data)
    } catch {
      return []
    }
  }

  /** Drop still-pending prompts from the ComfyUI queue (cancel support). */
  async deleteQueueItems(promptIds: string[]): Promise<boolean> {
    if (!promptIds.length) return true
    try {
      const res = await fetch(this.url('/queue'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: promptIds }),
        signal: AbortSignal.timeout(3000)
      })
      return res.ok
    } catch {
      return false
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
