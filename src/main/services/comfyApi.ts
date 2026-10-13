import type { ComfyJobSummary } from '@shared/types'

/** Stable client id so WS progress events match queued prompts. */
export const COMFY_CLIENT_ID = 'comfy-pilot'

/**
 * Lightweight ComfyUI HTTP helper used by monitor + batch + embed.
 *
 * 0.1.11: optional constructor headers. Remote instances with an `apiKey`
 * need `Authorization: Bearer …` on EVERY request — before this, only the
 * reachability probe sent the header and real submissions against protected
 * remotes failed with 401 after a green "online" test.
 */
export class ComfyApiClient {
  private readonly auth: Record<string, string>

  constructor(
    private baseUrl: string,
    opts?: { headers?: Record<string, string> }
  ) {
    this.auth = opts?.headers || {}
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  /** Merge configured auth headers under any per-call headers (call wins). */
  private authInit(init?: RequestInit): RequestInit {
    if (!Object.keys(this.auth).length) return init || {}
    const merged: Record<string, string> = {
      ...((init?.headers as Record<string, string> | undefined) || {})
    }
    for (const [key, value] of Object.entries(this.auth)) {
      if (!(key in merged)) merged[key] = value
    }
    return { ...(init || {}), headers: merged }
  }

  async systemStats(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(
        this.url('/system_stats'),
        this.authInit({ signal: AbortSignal.timeout(1500) })
      )
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async objectInfo(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(
        this.url('/object_info'),
        this.authInit({ signal: AbortSignal.timeout(5000) })
      )
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async queuePrompt(
    prompt: Record<string, unknown>,
    clientId: string,
    opts?: { metadata?: Record<string, unknown> }
  ): Promise<string | null> {
    try {
      const body: Record<string, unknown> = { prompt, client_id: clientId }
      // workflow_metadata (≤256 BYTES — the server validates the encoded
      // length) is merged into every prompt-scoped event by ComfyUI 0.39+;
      // older servers just ignore the extra top-level key. Oversized metadata
      // is dropped entirely (UTF-8 aware — a CJK name must not sneak past).
      if (opts?.metadata) {
        try {
          if (Buffer.byteLength(JSON.stringify(opts.metadata), 'utf-8') <= 256) {
            body.workflow_metadata = opts.metadata
          }
        } catch {
          /* non-serializable metadata is dropped, never fatal */
        }
      }
      const res = await fetch(
        this.url('/prompt'),
        this.authInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000)
        })
      )
      if (!res.ok) {
        // Surface ComfyUI's error body so callers can report WHY queueing failed.
        const text = await res.text().catch(() => '')
        let detail = text.slice(0, 500)
        try {
          const parsed = JSON.parse(text) as {
            error?: { message?: string; details?: string }
            node_errors?: Record<string, unknown>
          }
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
      const res = await fetch(
        this.url(`/history/${encodeURIComponent(promptId)}`),
        this.authInit({ signal: AbortSignal.timeout(3000) })
      )
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
      const res = await fetch(
        this.url('/history?max_items=' + limit),
        this.authInit({ signal: AbortSignal.timeout(5000) })
      )
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
      const res = await fetch(
        this.url('/queue'),
        this.authInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: promptIds }),
          signal: AbortSignal.timeout(3000)
        })
      )
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * Interrupt execution. With a promptId only that RUNNING prompt is
   * interrupted (ComfyUI 0.39+); without one the global interrupt flag is set.
   */
  async interrupt(promptId?: string, timeoutMs = 3000): Promise<boolean> {
    try {
      const res = await fetch(
        this.url('/interrupt'),
        this.authInit({
          method: 'POST',
          headers: promptId ? { 'Content-Type': 'application/json' } : undefined,
          body: promptId ? JSON.stringify({ prompt_id: promptId }) : undefined,
          signal: AbortSignal.timeout(timeoutMs)
        })
      )
      return res.ok
    } catch {
      return false
    }
  }

  // ---------- /api/jobs (ComfyUI 0.39+; callers must fall back on null/false) ----------

  /** Unified job list. `limit` is ALWAYS sent — the server returns everything without it. */
  async jobsList(limit = 50, status?: string): Promise<ComfyJob[] | null> {
    try {
      const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(500, limit))) })
      if (status) q.set('status', status)
      const res = await fetch(
        this.url(`/api/jobs?${q.toString()}`),
        this.authInit({ signal: AbortSignal.timeout(5000) })
      )
      if (!res.ok) return null
      const data = (await res.json()) as { jobs?: Array<Record<string, unknown>> }
      if (!Array.isArray(data.jobs)) return null
      return data.jobs.map((j) => ({
        id: String(j.id ?? ''),
        status: String(j.status ?? ''),
        workflowId: j.workflow_id ? String(j.workflow_id) : undefined,
        createdAt: typeof j.created_at === 'number' ? j.created_at : undefined
      }))
    } catch {
      return null
    }
  }

  /** Batch cancel (all-or-nothing validation server-side). */
  async jobsCancel(ids: string[]): Promise<boolean> {
    if (!ids.length) return true
    try {
      const res = await fetch(
        this.url('/api/jobs/cancel'),
        this.authInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_ids: ids }),
          signal: AbortSignal.timeout(5000)
        })
      )
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * POST /free {unload_models, free_memory} — release instance memory.
   * Used by remote maintenance (0.1.11): ComfyUI has no remote process
   * start/stop protocol, so memory release is the meaningful remote action.
   * Auth headers (when configured) travel via the constructor.
   */
  async freeMemory(): Promise<boolean> {
    try {
      const res = await fetch(
        this.url('/free'),
        this.authInit({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
          signal: AbortSignal.timeout(8000)
        })
      )
      return res.ok
    } catch {
      return false
    }
  }
}

/** Normalized /api/jobs list entry (alias of the shared type). */
export type ComfyJob = ComfyJobSummary
