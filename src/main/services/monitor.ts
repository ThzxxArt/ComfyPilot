import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import si from 'systeminformation'
import WebSocket from 'ws'
import type {
  ComfyJobSummary,
  ExecNodeProgress,
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
    if (origin === `http://${host}:${inst.port}` || origin === `https://${host}:${inst.port}`)
      return
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

/** Bearer headers for a configured remote whose origin matches this baseUrl
 *  (0.1.11) — monitoring a protected remote must authenticate like the probe. */
function remoteAuthHeadersForUrl(baseUrl: string): Record<string, string> {
  try {
    const origin = new URL(baseUrl).origin
    for (const remote of listRemotes()) {
      try {
        if (new URL(remote.baseUrl).origin === origin && remote.apiKey) {
          return { Authorization: `Bearer ${remote.apiKey}` }
        }
      } catch {
        /* skip malformed remote */
      }
    }
  } catch {
    /* invalid url */
  }
  return {}
}

export type GpuMemAdapter = {
  used: number
  total: number
  sharedUsed?: number
  sharedTotal?: number
}

/**
 * systeminformation often omits memoryUsed/memoryTotal on Windows
 * (nvidia-smi/NVML unavailable). Fall back to the GPU Adapter Memory
 * performance counters, which report Dedicated Usage / Limit in bytes.
 * 0.1.11: also samples Shared Usage / Limit (system RAM shared with the GPU).
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
    "$su=Get-Counter '\\GPU Adapter Memory(*)\\Shared Usage' -ErrorAction SilentlyContinue",
    "$sl=Get-Counter '\\GPU Adapter Memory(*)\\Shared Limit' -ErrorAction SilentlyContinue",
    '$map=@{}',
    'foreach($s in @($u.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0;sharedUsed=0;sharedTotal=0}}; $map[$k].used=[long]$s.CookedValue }',
    'foreach($s in @($l.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0;sharedUsed=0;sharedTotal=0}}; $map[$k].total=[long]$s.CookedValue }',
    'foreach($s in @($su.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0;sharedUsed=0;sharedTotal=0}}; $map[$k].sharedUsed=[long]$s.CookedValue }',
    'foreach($s in @($sl.CounterSamples)){ $k=$s.InstanceName; if(-not $map[$k]){$map[$k]=@{used=0;total=0;sharedUsed=0;sharedTotal=0}}; $map[$k].sharedTotal=[long]$s.CookedValue }',
    "$map.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Output ($_.Name + ',' + $_.Value.used + ',' + $_.Value.total + ',' + $_.Value.sharedUsed + ',' + $_.Value.sharedTotal) }"
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
      const m = line.trim().match(/^.+,(\d+),(\d+),(\d+),(\d+)$/)
      if (!m) continue
      const used = Number(m[1])
      const total = Number(m[2])
      const sharedUsed = Number(m[3])
      const sharedTotal = Number(m[4])
      if (Number.isFinite(used) && Number.isFinite(total)) {
        adapters.push({ used, total, sharedUsed, sharedTotal })
      }
    }
    gpuMemCache = { at: now, adapters }
    return adapters
  } catch {
    return gpuMemCache?.adapters || []
  }
}

/** Merge controller + adapter memory into byte totals. Exported for tests. */
export function mergeGpuMemory(
  controllers: Array<{
    vram?: number | null
    memoryUsed?: number | null
    memoryTotal?: number | null
  }>,
  adapters: GpuMemAdapter[]
): Array<{ vramTotal: number; vramUsed: number; sharedUsed?: number; sharedTotal?: number }> {
  const free = adapters.map((a, i) => ({ ...a, i, taken: false }))
  return controllers.map((c) => {
    const siTotal = (c.memoryTotal || 0) * 1024 * 1024
    const siUsed = (c.memoryUsed || 0) * 1024 * 1024
    const vramBytes = (c.vram || 0) * 1024 * 1024

    // Prefer explicit si values when they look real. Shared memory has no si
    // source — attach the first adapter that actually reports a shared limit.
    if (siTotal > 0 && siUsed > 0) {
      const sharedSrc = adapters.find((a) => (a.sharedTotal || 0) > 0)
      return {
        vramTotal: siTotal,
        vramUsed: Math.min(siUsed, siTotal),
        sharedUsed: sharedSrc?.sharedUsed,
        sharedTotal: sharedSrc?.sharedTotal
      }
    }

    // Match a perf-counter adapter by closest dedicated limit
    let hit = free.find(
      (a) =>
        !a.taken &&
        a.total > 0 &&
        vramBytes > 0 &&
        Math.abs(a.total - vramBytes) <= Math.max(vramBytes * 0.12, 64 * 1024 * 1024)
    )
    if (!hit) hit = free.find((a) => !a.taken && a.total > 0)
    if (!hit) hit = free.find((a) => !a.taken && a.used > 0)
    if (hit) {
      hit.taken = true
      const total = hit.total > 0 ? hit.total : vramBytes
      const used = Math.min(Math.max(hit.used, 0), total || hit.used)
      return {
        vramTotal: total || vramBytes,
        vramUsed: used,
        sharedUsed: hit.sharedUsed,
        sharedTotal: hit.sharedTotal
      }
    }

    return { vramTotal: vramBytes, vramUsed: 0 }
  })
}

/** WebSocket#readyState values, numeric so the mocked `ws` in tests needs no statics. */
const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSED = 3

function isWsLive(ws: WebSocket): boolean {
  return ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN
}

export class MonitorService extends EventEmitter {
  private last: SystemSnapshot | null = null
  private ws: WebSocket | null = null
  private wsBaseUrl = ''
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  /**
   * Connection generation. Bumped on every connectWs/disconnectWs so that a
   * stale close/error handler from a previous socket can never schedule a
   * reconnect against the current wsBaseUrl (which would open a duplicate WS).
   */
  private wsGeneration = 0
  /** Preview frame throttle (0.1.10): at most one emitted frame per 300ms. */
  private lastPreviewAt = 0

  /**
   * 0.1.18 (WP4): sampling used to take 2.6–3.4 s per tick and ticks could
   * overlap (a 2 s interval against a 3 s sample). Now:
   * - single-flight: concurrent callers share one in-flight sample,
   * - tiered cache: CPU/RAM 2 s, GPU 5 s, disk 10 s,
   * - the renderer's 2 s tick and the `monitor.system` IPC both read the cache.
   */
  private snapshotAt = 0
  private inflight: Promise<SystemSnapshot> | null = null
  private cpuCache: {
    at: number
    cpu: Awaited<ReturnType<typeof si.currentLoad>> | null
    mem: Awaited<ReturnType<typeof si.mem>> | null
  } | null = null
  private gpuCache: {
    at: number
    graphics: Awaited<ReturnType<typeof si.graphics>> | null
    adapters: GpuMemAdapter[]
  } | null = null
  private diskCache: {
    at: number
    fsSize: Awaited<ReturnType<typeof si.fsSize>> | null
  } | null = null

  /**
   * 0.1.18 (WP7): bounded 10-minute series (2 s cadence → 300 points) for the
   * monitor chart, plus threshold alerts. The renderer used to keep its own
   * 60-point CPU array that died on navigation; history now survives the page.
   */
  private series: Array<{ ts: number; cpu: number; ram: number; vram: number }> = []
  private thresholdAt: Record<string, number> = {}

  seriesSnapshot(): Array<{ ts: number; cpu: number; ram: number; vram: number }> {
    return [...this.series]
  }

  private recordSeries(s: SystemSnapshot): void {
    const ram = s.ramTotal > 0 ? (s.ramUsed / s.ramTotal) * 100 : 0
    const gpu = s.gpus[0]
    const vram = gpu && gpu.vramTotal > 0 ? (gpu.vramUsed / gpu.vramTotal) * 100 : 0
    this.series.push({
      ts: s.timestamp,
      cpu: s.cpuUsage,
      ram: Math.round(ram),
      vram: Math.round(vram)
    })
    if (this.series.length > 300) this.series.splice(0, this.series.length - 300)
    this.checkThresholds(Math.round(ram), Math.round(vram))
  }

  /** At most one notice per metric per 5 minutes, never on every tick. */
  private checkThresholds(ram: number, vram: number): void {
    const now = Date.now()
    const alerts: Array<{ key: string; titleKey: string; value: number }> = []
    if (vram >= 90) alerts.push({ key: 'vram', titleKey: 'notify.vramHigh', value: vram })
    if (ram >= 95) alerts.push({ key: 'ram', titleKey: 'notify.ramHigh', value: ram })
    for (const a of alerts) {
      if (now - (this.thresholdAt[a.key] || 0) < 5 * 60 * 1000) continue
      this.thresholdAt[a.key] = now
      void import('../ipc/handlers')
        .then(({ broadcastNotification }) => {
          broadcastNotification({
            type: 'warning',
            title: `${a.titleKey} ${a.value}%`,
            titleKey: a.titleKey,
            params: { value: a.value },
            message: '',
            duration: 8000
          })
        })
        .catch(() => undefined)
    }
  }

  /** Never rejects: partial si failures degrade instead of blowing up the tick. */
  async systemSnapshot(opts: { force?: boolean } = {}): Promise<SystemSnapshot> {
    const now = Date.now()
    if (!opts.force && this.last && now - this.snapshotAt < 2000) return this.last
    if (this.inflight) return this.inflight
    this.inflight = this.sampleSnapshot(now).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async sampleSnapshot(now: number): Promise<SystemSnapshot> {
    const cpuFresh = Boolean(this.cpuCache && now - this.cpuCache.at < 2000)
    const gpuFresh = Boolean(this.gpuCache && now - this.gpuCache.at < 5000)
    const diskFresh = Boolean(this.diskCache && now - this.diskCache.at < 10000)
    try {
      const [cpu, mem, fsSize, graphics] = await Promise.all([
        cpuFresh ? Promise.resolve(this.cpuCache?.cpu) : si.currentLoad().catch(() => null),
        cpuFresh ? Promise.resolve(this.cpuCache?.mem) : si.mem().catch(() => null),
        diskFresh ? Promise.resolve(this.diskCache?.fsSize) : si.fsSize().catch(() => null),
        gpuFresh
          ? Promise.resolve(this.gpuCache?.graphics)
          : Promise.all([
              si.graphics().catch(() => null),
              sampleWindowsGpuMemory().catch(() => [] as GpuMemAdapter[])
            ]).then(([g, adapters]) => {
              // A single failed si.graphics() must not replace the last good
              // reading with "no GPU" for the next 5 s (and a 0% VRAM point).
              if (g) this.gpuCache = { at: now, graphics: g, adapters }
              return g ?? this.gpuCache?.graphics ?? null
            })
      ])
      if (!cpuFresh) this.cpuCache = { at: now, cpu: cpu ?? null, mem: mem ?? null }
      if (!diskFresh) this.diskCache = { at: now, fsSize: fsSize ?? null }
      const adapters = this.gpuCache?.adapters || []

      const controllers = graphics?.controllers || []
      const memPair = mergeGpuMemory(controllers, adapters)
      const gpus: GpuInfo[] = controllers.map((c, index) => ({
        index,
        model: c.model || 'Unknown GPU',
        vendor: c.vendor || 'unknown',
        vramTotal: memPair[index]?.vramTotal || (c.vram || 0) * 1024 * 1024,
        vramUsed: memPair[index]?.vramUsed || 0,
        // integer percent — renderer prints this verbatim
        utilization: Math.round(c.utilizationGpu || 0),
        temperature: c.temperatureGpu != null ? Math.round(c.temperatureGpu) : undefined,
        powerDraw: (c.powerDraw || 0) > 0 ? Math.round((c.powerDraw || 0) * 10) / 10 : undefined,
        // Shared (system RAM) usage — Windows counters only; undefined elsewhere.
        sharedUsed: memPair[index]?.sharedUsed,
        sharedTotal: memPair[index]?.sharedTotal
      }))

      const root = fsSize && fsSize[0]
      const snapshot: SystemSnapshot = {
        cpuUsage: cpu ? Math.round(cpu.currentLoad * 10) / 10 : (this.last?.cpuUsage ?? 0),
        ramTotal: mem?.total ?? this.last?.ramTotal ?? 0,
        ramUsed: mem?.used ?? this.last?.ramUsed ?? 0,
        diskFree: root?.available ?? this.last?.diskFree ?? 0,
        diskTotal: root?.size ?? this.last?.diskTotal ?? 0,
        gpus,
        timestamp: Date.now()
      }
      this.last = snapshot
      this.snapshotAt = Date.now()
      this.recordSeries(snapshot)
      return snapshot
    } catch {
      // Prefer the last good sample over fabricating 0% CPU / 0 GB free, which
      // consumers render as real telemetry.
      if (this.last) return this.last
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

  async queueSnapshot(baseUrl?: string): Promise<QueueSnapshot> {
    const empty: QueueSnapshot = { running: [], pending: [], doneCount: 0, history: [] }
    if (!baseUrl) return empty
    assertMonitorBaseUrl(baseUrl)
    const auth = remoteAuthHeadersForUrl(baseUrl)
    const client = new ComfyApiClient(baseUrl, { headers: auth })
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/queue`, {
        headers: auth,
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

  /**
   * Job list via /api/jobs (ComfyUI 0.39+). Returns null when the endpoint is
   * unavailable — callers keep the legacy queue view (0.1.10, probed not guessed).
   */
  async jobsSnapshot(baseUrl?: string): Promise<ComfyJobSummary[] | null> {
    if (!baseUrl) return null
    assertMonitorBaseUrl(baseUrl)
    const client = new ComfyApiClient(baseUrl, { headers: remoteAuthHeadersForUrl(baseUrl) })
    return client.jobsList(30)
  }

  // ---------- Queue / memory operations (0.1.15) ----------
  // The three standard ComfyUI runtime operations, now first-class in the
  // monitor: clear the pending queue, interrupt the running task, free memory.
  // All go through ComfyApiClient so remote auth headers / URL trust checks
  // are identical to every other monitor call. Honest results — never a
  // fabricated success.

  private opClient(baseUrl: string): ComfyApiClient {
    assertMonitorBaseUrl(baseUrl)
    return new ComfyApiClient(baseUrl, { headers: remoteAuthHeadersForUrl(baseUrl) })
  }

  /** Clear every PENDING queue item; the running job keeps executing. */
  async clearQueue(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const ok = await this.opClient(baseUrl).clearQueue()
      return ok ? { ok: true } : { ok: false, error: `queue clear was not accepted by ${baseUrl}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Interrupt the running task. A promptId directs the interrupt to that
   * prompt on ComfyUI 0.39+ (older builds ignore the body → global interrupt).
   */
  async interrupt(baseUrl: string, promptId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const ok = await this.opClient(baseUrl).interrupt(promptId || undefined)
      return ok ? { ok: true } : { ok: false, error: `interrupt was not accepted by ${baseUrl}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Unload models + free memory (`POST /free`). Next generation reloads them. */
  async freeMemory(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const ok = await this.opClient(baseUrl).freeMemory()
      return ok ? { ok: true } : { ok: false, error: `free request was not accepted by ${baseUrl}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  connectWs(baseUrl: string): boolean {
    assertMonitorBaseUrl(baseUrl)
    // Idempotent for the same live target: repeated UI subscribes (route
    // re-entry, status ticks) must keep the current socket. Tearing down and
    // reopening back-to-back races the ComfyUI server session tables — the
    // old connection's teardown pops the shared `sockets`/`sockets_metadata`
    // entry AFTER the replacement registered, so the new socket goes
    // invisible and its first feature_flags message dies with
    // `KeyError: 'comfy-pilot'` (0.1.11.1).
    if (this.ws && this.wsBaseUrl === baseUrl && isWsLive(this.ws)) return true

    const prev = this.ws
    this.disconnectWs()
    this.reconnectAttempts = 0
    this.wsBaseUrl = baseUrl
    const gen = this.wsGeneration
    const open = (): void => {
      if (gen === this.wsGeneration && this.wsBaseUrl === baseUrl) this.openWs(baseUrl, gen)
    }
    if (prev && prev.readyState !== WS_CLOSED) {
      // Serialize: let the old socket finish its close handshake (plus a
      // small grace for the server-side handler teardown) before opening the
      // replacement. Overlapping sockets under one clientId are the race
      // described above.
      let started = false
      const start = (): void => {
        if (started) return
        started = true
        setTimeout(open, 250)
      }
      try {
        prev.once('close', start)
        prev.once('error', start)
      } catch {
        start()
      }
      // Safety net: proceed even if the old socket never reports close.
      setTimeout(start, 1000)
    } else {
      open()
    }
    return true
  }

  private openWs(baseUrl: string, gen: number): boolean {
    const wsUrl =
      baseUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws?clientId=' + COMFY_CLIENT_ID
    try {
      // Protected remotes authenticate the WS upgrade too (0.1.11).
      const wsAuth = remoteAuthHeadersForUrl(baseUrl)
      const ws = Object.keys(wsAuth).length
        ? new WebSocket(wsUrl, { headers: wsAuth })
        : new WebSocket(wsUrl)
      this.ws = ws
      ws.on('open', () => {
        if (gen !== this.wsGeneration) return
        this.reconnectAttempts = 0
        this.emit('ws', { type: 'status', text: 'connected' } as ExecProgressEvent)
        // Ask for metadata-framed previews (event=4). Only the FIRST message is
        // treated as negotiation by the server, so this must go out immediately;
        // older servers ignore it and keep emitting legacy frames (still parsed).
        try {
          ws.send(
            JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } })
          )
        } catch {
          /* negotiation is best-effort */
        }
      })
      ws.on('message', (raw) => {
        if (gen !== this.wsGeneration) return
        try {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
          // Binary frames start with a big-endian event number (1/2/3/4).
          // JSON frames start with '{' (0x7B) — route by event code, never by
          // "first byte == 0x00" (the old guard silently dropped every preview).
          if (buf.length >= 4) {
            const event = buf.readUInt32BE(0)
            if (event === 1 || event === 2 || event === 3 || event === 4) {
              this.handleBinaryFrame(gen, event, buf)
              return
            }
          }
          const msg = JSON.parse(buf.toString('utf-8')) as {
            type: string
            data?: Record<string, unknown>
          }
          this.emit('ws', this.buildExecEvent(msg))
        } catch {
          /* ignore malformed */
        }
      })
      ws.on('close', () => {
        if (gen !== this.wsGeneration) return
        this.emit('ws', { type: 'status', text: 'disconnected' } as ExecProgressEvent)
        this.scheduleReconnect(gen)
      })
      ws.on('error', () => {
        if (gen !== this.wsGeneration) return
        this.emit('ws', { type: 'status', text: 'error' } as ExecProgressEvent)
        this.scheduleReconnect(gen)
      })
      return true
    } catch {
      this.scheduleReconnect(gen)
      return false
    }
  }

  /**
   * Decode binary WS frames (0.1.10). Two preview generations exist:
   *  - event 1/2: [4B event][4B imageType] + image (1=JPEG, 2=PNG)
   *  - event 4:   [4B event][4B metaLen][JSON metadata][image]
   *  - event 3 is progress TEXT — ignored (no consumer).
   * Unknown/truncated frames are dropped silently; previews are throttled.
   */
  private handleBinaryFrame(gen: number, event: number, buf: Buffer): void {
    if (gen !== this.wsGeneration) return
    if (event === 3) return
    try {
      if (event === 1 || event === 2) {
        if (buf.length <= 8) return
        const imgType = buf.readUInt32BE(4)
        const mime = imgType === 1 ? 'image/jpeg' : 'image/png'
        this.emitPreview(mime, buf.subarray(8))
        return
      }
      if (event === 4) {
        if (buf.length < 8) return
        const metaLen = buf.readUInt32BE(4)
        if (!Number.isFinite(metaLen) || metaLen < 0 || buf.length < 8 + metaLen) return
        let meta: Record<string, unknown> = {}
        try {
          meta = JSON.parse(buf.toString('utf-8', 8, 8 + metaLen)) as Record<string, unknown>
        } catch {
          /* keep empty meta; the image bytes are still valid */
        }
        const image = buf.subarray(8 + metaLen)
        if (!image.length) return
        this.emitPreview(String(meta.image_type || 'image/png'), image, meta)
      }
    } catch {
      /* malformed frame — never crash the socket handler */
    }
  }

  private emitPreview(mime: string, image: Buffer, meta?: Record<string, unknown>): void {
    const now = Date.now()
    if (now - this.lastPreviewAt < 300) return
    this.lastPreviewAt = now
    this.emit('ws', {
      type: 'preview',
      image: `data:${mime};base64,${image.toString('base64')}`,
      nodeId: meta?.node_id ? String(meta.node_id) : undefined,
      promptId: meta?.prompt_id ? String(meta.prompt_id) : undefined
    } satisfies ExecProgressEvent)
  }

  /** JSON event → ExecProgressEvent (adds progress_state / execution_cached). */
  private buildExecEvent(msg: { type: string; data?: Record<string, unknown> }): ExecProgressEvent {
    const d = (msg.data || {}) as Record<string, unknown>
    const evt: ExecProgressEvent = {
      type: msg.type as ExecProgressEvent['type'],
      nodeId: d.node ? String(d.node) : undefined,
      value: d.value as number | undefined,
      max: d.max as number | undefined,
      promptId: d.prompt_id ? String(d.prompt_id) : undefined,
      text: d.text ? String(d.text) : undefined,
      /** Main-process routing only (failure diagnosis maps URL → instance). */
      baseUrl: this.wsBaseUrl || undefined
    }
    // 0.1.12: execution_error carries the full failure payload (exception_type/
    // exception_message/traceback/node_type/node_id — broadcast=False to the
    // submitting client). Previously only the id fields survived the mapping,
    // so a failed run showed up as an unexplained red row.
    if (msg.type === 'execution_error' || msg.type === 'execution_interrupted') {
      if (d.node_id != null) evt.nodeId = String(d.node_id)
      if (d.prompt_id != null) evt.promptId = String(d.prompt_id)
      if (d.node_type != null) evt.nodeType = String(d.node_type)
      if (msg.type === 'execution_error') {
        if (d.exception_type != null) evt.errorType = String(d.exception_type)
        if (d.exception_message != null) evt.errorMessage = String(d.exception_message)
        if (Array.isArray(d.traceback)) {
          evt.errorTraceback = (d.traceback as unknown[])
            .map(String)
            .slice(-80)
            .map((s) => s.slice(0, 500))
        }
      }
    }
    if (msg.type === 'progress_state' && d.nodes && typeof d.nodes === 'object') {
      const nodes: Record<string, ExecNodeProgress> = {}
      for (const [id, raw] of Object.entries(d.nodes as Record<string, Record<string, unknown>>)) {
        if (!raw || typeof raw !== 'object') continue
        nodes[id] = {
          nodeId: id,
          value: Number(raw.value ?? 0),
          max: Number(raw.max ?? 0),
          state: String(raw.state || ''),
          promptId: raw.prompt_id ? String(raw.prompt_id) : undefined,
          displayNodeId: raw.display_node_id ? String(raw.display_node_id) : undefined
        }
      }
      evt.nodes = nodes
      const running = Object.entries(nodes).filter(([, n]) => n.state === 'running')
      if (running.length) evt.nodeId = running[running.length - 1][0]
    }
    if (msg.type === 'execution_cached' && Array.isArray(d.nodes)) {
      evt.cachedNodes = (d.nodes as unknown[]).map(String)
    }
    return evt
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.wsGeneration) return
    if (!this.wsBaseUrl) return
    if (this.reconnectTimer) return
    // Retry forever; exponential backoff capped at 60s.
    const delay = Math.min(60000, 500 * 2 ** Math.min(this.reconnectAttempts, 10))
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (gen !== this.wsGeneration) return
      if (this.wsBaseUrl) {
        try {
          this.openWs(this.wsBaseUrl, gen)
        } catch {
          this.scheduleReconnect(gen)
        }
      }
    }, delay)
  }

  disconnectWs(): void {
    this.wsGeneration += 1
    this.wsBaseUrl = ''
    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners()
        // An intentional close can still surface as an 'error' event (e.g. an
        // aborted handshake). Without any listener Node re-throws it as
        // ERR_UNHANDLED_ERROR inside the main process.
        this.ws.on('error', () => {})
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }
}

export const monitorService = new MonitorService()
