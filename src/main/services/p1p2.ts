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
  /** Ids with an in-flight run; cancel() clears the flag so late prompt results are ignored. */
  private runningIds = new Set<string>()

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
      this.runningIds.add(id)
      try {
        for (let i = 0; i < job.count; i++) {
          const current = listBatchJobs().find((j) => j.id === id)
          if (!this.runningIds.has(id) || current?.status === 'cancelled') {
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
            // cancel() clears runningIds immediately; already-queued prompts must
            // not be recorded as success once the job is cancelled.
            const live = listBatchJobs().find((j) => j.id === id)
            if (!this.runningIds.has(id) || live?.status === 'cancelled') {
              // dropped: result arrived after cancel
            } else if (promptId) {
              job.promptIds.push(promptId)
              job.completed += 1
            } else {
              job.failed += 1
            }
          } catch (err) {
            job.failed += 1
            // Surface WHY the queue call failed (was silently counting failures).
            const msg = err instanceof Error ? err.message : String(err)
            job.notes = [job.notes, `#${i + 1} ${msg}`].filter(Boolean).join('; ').slice(-500)
          }
          const after = listBatchJobs().find((j) => j.id === id)
          if (!this.runningIds.has(id) || after?.status === 'cancelled') {
            // Persist this iteration's progress before honouring the cancel.
            job.status = 'cancelled'
            job.finishedAt = after?.finishedAt ?? Date.now()
            upsertBatchJob(job)
            this.emit('progress', job)
            return job
          }
          upsertBatchJob(job)
          this.emit('progress', job)
        }
      } finally {
        this.runningIds.delete(id)
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
    // Clear the local running flag immediately so already-queued prompts are
    // ignored when their results arrive (see start()).
    this.runningIds.delete(id)
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
    const headers: Record<string, string> = remote.apiKey
      ? { Authorization: `Bearer ${remote.apiKey}` }
      : {}
    try {
      const res = await fetch(`${remote.baseUrl.replace(/\/$/, '')}/system_stats`, {
        headers,
        signal: AbortSignal.timeout(4000)
      })
      if (!res.ok) return { id, online: false, queueRunning: 0, queuePending: 0, error: `HTTP ${res.status}` }
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

export class MarketService {
  async list(opts?: {
    query?: string
    category?: string
    limit?: number
    page?: number
    scanPages?: number
    instanceId?: string
  }) {
    const settings = loadSettings()
    try {
      const { searchRegistry, toPageResult, mapMarketItem, packKeyVariants } = await import('./registry')
      const result = await searchRegistry({
        query: opts?.query,
        limit: opts?.limit,
        page: opts?.page,
        scanPages: opts?.scanPages
      })
      // Installed detection must target the selected instance's custom_nodes.
      // Match on directory name AND pack metadata name/registryId — registry
      // `name` often differs from the folder the zip extracted to.
      let instancePath = settings.defaultInstancePath
      if (opts?.instanceId) {
        const inst = loadInstanceConfigs().find((c) => c.id === opts.instanceId)
        if (inst?.path) instancePath = inst.path
      }
      const installed = collectInstalledKeys(instancePath, packKeyVariants)
      try {
        const { nodePackService } = await import('./nodePack')
        for (const p of nodePackService.list(opts?.instanceId)) {
          if (p.name) for (const v of packKeyVariants(p.name)) installed.add(v)
          if (p.registryId) for (const v of packKeyVariants(p.registryId)) installed.add(v)
        }
      } catch {
        /* nodePack unavailable — directory keys still apply */
      }
      return toPageResult(result, (n) => mapMarketItem(n, installed, opts?.category || 'tools'))
    } catch (err) {
      if (settings.networkMode === 'offline') {
        return {
          items: [],
          total: 0,
          page: opts?.page || 1,
          pageSize: opts?.limit || 50,
          totalPages: 0,
          scanned: 0,
          clientFiltered: Boolean(opts?.query)
        }
      }
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

/**
 * Keys that mark a registry item as already installed: every normalized form
 * of the directory basename. Metadata names / registryIds are merged in by the
 * caller once nodePack is loaded.
 */
function collectInstalledKeys(instancePath: string, variants: (s: string) => string[]): Set<string> {
  const keys = new Set<string>()
  for (const n of readdirSafe(instancePath)) {
    if (n.startsWith('.') || n === '__pycache__' || n === '__MACOSX' || n === 'node_modules') continue
    for (const v of variants(n)) keys.add(v)
  }
  return keys
}

export const marketService = new MarketService()

void mkdirSync
