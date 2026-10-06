import { EventEmitter } from 'events'
import { randomUUID, createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, extname, basename } from 'path'
import type { BatchJob, OutputAsset, RemoteInstanceConfig, RemoteInstanceStatus } from '@shared/types'
import {
  deleteBatchJob,
  listBatchJobs,
  listOutputAssets,
  listRemotes,
  upsertBatchJob,
  upsertOutputAsset,
  upsertRemote,
  deleteRemote,
  loadInstanceConfigs,
  loadSettings
} from './db'
import { ComfyApiClient } from './comfyApi'
import { extractPngTextMeta } from './workflow'

export class BatchService extends EventEmitter {
  list(): BatchJob[] {
    return listBatchJobs()
  }

  create(
    job: Omit<BatchJob, 'id' | 'status' | 'completed' | 'failed' | 'createdAt' | 'promptIds'>
  ): BatchJob {
    const rec: BatchJob = {
      ...job,
      id: randomUUID(),
      status: 'queued',
      completed: 0,
      failed: 0,
      createdAt: Date.now(),
      promptIds: []
    }
    upsertBatchJob(rec)
    return rec
  }

  async start(id: string): Promise<BatchJob> {
    const jobs = listBatchJobs()
    const job = jobs.find((j) => j.id === id)
    if (!job) throw new Error('Batch job not found')
    job.status = 'running'
    upsertBatchJob(job)
    this.emit('progress', job)

    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === job.instanceId) || instances[0]
    if (!inst) {
      job.status = 'error'
      job.finishedAt = Date.now()
      upsertBatchJob(job)
      throw new Error('No instance')
    }
    const url = `http://${inst.listen === '0.0.0.0' ? '127.0.0.1' : inst.listen}:${inst.port}`
    const client = new ComfyApiClient(url)

    let prompt: Record<string, unknown> | null = null
    try {
      const raw = readFileSync(job.workflowPath, 'utf-8')
      try {
        prompt = JSON.parse(raw)
      } catch {
        prompt = null
      }
      if (!prompt && extname(job.workflowPath).toLowerCase() === '.png') {
        try {
          const meta = extractPngTextMeta(readFileSync(job.workflowPath))
          if (meta.prompt) prompt = JSON.parse(String(meta.prompt))
        } catch {
          prompt = null
        }
      }
    } catch {
      prompt = null
    }
    if (!prompt) {
      job.status = 'error'
      job.finishedAt = Date.now()
      upsertBatchJob(job)
      throw new Error('Cannot parse workflow')
    }
    try {
      const { toApiPrompt, applySeedForIteration } = await import('./workflowConvert')
      const { COMFY_CLIENT_ID } = await import('./comfyApi')
      const baseSeed = Date.now() % 2 ** 32
      for (let i = 0; i < job.count; i++) {
        const current = listBatchJobs().find((j) => j.id === id)
        if (current?.status === 'cancelled') {
          job.status = 'cancelled'
          job.finishedAt = Date.now()
          upsertBatchJob(job)
          this.emit('progress', job)
          return job
        }
        const promptForRun = applySeedForIteration(toApiPrompt(prompt), baseSeed, i)
        try {
          // Same clientId as WS so live progress is visible in Monitor
          const promptId = await client.queuePrompt(promptForRun, COMFY_CLIENT_ID)
          if (promptId) {
            job.promptIds.push(promptId)
            job.completed += 1
          } else {
            job.failed += 1
          }
        } catch {
          job.failed += 1
        }
        const after = listBatchJobs().find((j) => j.id === id)
        if (after?.status === 'cancelled') {
          return after
        }
        upsertBatchJob(job)
        this.emit('progress', job)
      }
    } catch (e) {
      job.status = 'error'
      job.finishedAt = Date.now()
      upsertBatchJob(job)
      throw e
    }

    // Do not overwrite a cancel that landed after the last iteration check
    const latest = listBatchJobs().find((j) => j.id === id)
    if (latest?.status === 'cancelled') {
      return latest
    }
    job.status = job.failed > 0 && job.completed === 0 ? 'error' : 'done'
    job.finishedAt = Date.now()
    upsertBatchJob(job)
    this.emit('progress', job)
    return job
  }

  cancel(id: string): BatchJob {
    const job = listBatchJobs().find((j) => j.id === id)
    if (!job) throw new Error('Batch job not found')
    job.status = 'cancelled'
    job.finishedAt = Date.now()
    upsertBatchJob(job)
    return job
  }

  remove(id: string): boolean {
    return deleteBatchJob(id)
  }
}

export const batchService = new BatchService()

export class OutputService {
  list(opts?: { root?: string; type?: string; limit?: number }): OutputAsset[] {
    const settings = loadSettings()
    const roots = [opts?.root, settings.outputIndexRoot].filter(Boolean) as string[]
    if (!roots.length) return listOutputAssets(opts?.limit || 200)

    const assets: OutputAsset[] = []
    for (const root of roots) {
      if (!existsSync(root)) continue
      this.walk(root, assets, 0)
    }
    for (const a of assets) upsertOutputAsset(a)
    const all = listOutputAssets(opts?.limit || 200)
    return opts?.type ? all.filter((a) => a.type === opts.type) : all
  }

  private walk(dir: string, out: OutputAsset[], depth: number): void {
    if (depth > 4) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) {
          this.walk(full, out, depth + 1)
          continue
        }
        const ext = extname(name).toLowerCase()
        const type: OutputAsset['type'] = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)
          ? 'image'
          : ['.mp4', '.webm', '.mov'].includes(ext)
            ? 'video'
            : ['.wav', '.mp3', '.flac'].includes(ext)
              ? 'audio'
              : 'other'
        if (type === 'other') continue

        let params: Record<string, unknown> = {}
        let seed: number | undefined
        let promptId: string | undefined
        if (type === 'image' && ext === '.png') {
          try {
            const meta = extractPngTextMeta(readFileSync(full))
            // ComfyUI stores seed / prompt_id inside the embedded prompt JSON
            if (meta.prompt) {
              try {
                const prompt = JSON.parse(String(meta.prompt)) as Record<
                  string,
                  { inputs?: Record<string, unknown>; class_type?: string }
                >
                params.nodeCount = Object.keys(prompt).length
                for (const node of Object.values(prompt)) {
                  if (node?.inputs && typeof node.inputs.seed === 'number' && seed == null) {
                    seed = node.inputs.seed as number
                  }
                }
              } catch {
                /* ignore */
              }
            }
            if (meta.seed && seed == null) seed = Number(meta.seed)
            if (meta.prompt_id) promptId = String(meta.prompt_id)
            params = {
              ...params,
              pngKeys: Object.keys(meta),
              workflow: undefined,
              prompt: undefined
            }
          } catch {
            /* ignore */
          }
        }

        out.push({
          id: createHash('sha1').update(full).digest('hex').slice(0, 16),
          path: full,
          fileName: basename(full),
          type,
          size: st.size,
          createdAt: st.mtimeMs,
          seed,
          promptId,
          params
        })
      } catch {
        /* skip */
      }
    }
  }

  open(path: string): boolean {
    return existsSync(path)
  }
}

export const outputService = new OutputService()

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
    try {
      const res = await fetch(`${remote.baseUrl.replace(/\/$/, '')}/system_stats`, {
        headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {},
        signal: AbortSignal.timeout(4000)
      })
      if (!res.ok) return { id, online: false, queueRunning: 0, queuePending: 0, error: `HTTP ${res.status}` }
      const queueRes = await fetch(`${remote.baseUrl.replace(/\/$/, '')}/queue`, {
        signal: AbortSignal.timeout(3000)
      })
      const queue = (await queueRes.json()) as {
        queue_running?: unknown[]
        queue_pending?: unknown[]
      }
      return {
        id,
        online: true,
        queueRunning: queue.queue_running?.length || 0,
        queuePending: queue.queue_pending?.length || 0
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

export class MarketService {
  async list(opts?: { query?: string; category?: string }) {
    const settings = loadSettings()
    try {
      const q = encodeURIComponent(opts?.query || '')
      const url = `https://api.comfy.org/nodes?limit=50${q ? `&search=${q}` : ''}`
      const res = await fetch(url, {
        headers: { 'User-Agent': 'ComfyPilot/0.1' },
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { nodes?: Array<Record<string, unknown>> }
      const installed = new Set(
        readdirSafe(settings.defaultInstancePath)
      )
      return (data.nodes || []).map((n) => ({
        id: String(n.id || n.name),
        name: String(n.name || ''),
        displayName: String(n.displayName || n.name),
        description: String(n.description || ''),
        author: String((n.publisher as { name?: string } | undefined)?.name || n.author || ''),
        version: String(n.latest_version || ''),
        category: String(n.category || opts?.category || 'tools'),
        tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
        downloads: Number(n.downloads || 0),
        stars: Number(n.stars || n.score || 0),
        installed: installed.has(String(n.name || '')),
        repository: String(n.repository || ''),
        icon: n.icon ? String(n.icon) : undefined,
        rating: Number(n.rating || 4.5)
      }))
    } catch (err) {
      if (settings.networkMode === 'offline') return []
      throw err
    }
  }
}

function readdirSafe(instancePath: string): string[] {
  if (!instancePath) return []
  try {
    const dir = join(instancePath, 'custom_nodes')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
  } catch {
    return []
  }
}

export const marketService = new MarketService()

void mkdirSync
