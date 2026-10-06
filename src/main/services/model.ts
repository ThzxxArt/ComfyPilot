import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  createWriteStream,
  createReadStream,
  openSync,
  readSync,
  closeSync,
  renameSync,
  symlinkSync,
  mkdirSync,
  readFileSync
} from 'fs'
import { join, extname, basename, dirname, parse } from 'path'
import { homedir } from 'os'
import { load } from 'js-yaml'
import type {
  DownloadTask,
  DuplicateGroup,
  ModelCategory,
  ModelRecord,
  ModelScanProgress,
  StorageStats
} from '@shared/types'
import {
  findModelByPath,
  listModels,
  deleteModel as dbDeleteModel,
  loadSettings,
  upsertModel,
  updateModel,
  upsertDownloadTask,
  listDownloadTasks
} from './db'

const MODEL_EXT = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'])

const CATEGORY_BY_DIR: Record<string, ModelCategory> = {
  checkpoints: 'checkpoints',
  diffusion_models: 'diffusion_models',
  unet: 'unet',
  loras: 'loras',
  vae: 'vae',
  clip: 'clip',
  text_encoders: 'text_encoders',
  controlnet: 'controlnet',
  upscale_models: 'upscale_models',
  embeddings: 'embeddings',
  hypernetworks: 'other',
  style_models: 'other'
}

function categorize(path: string): ModelCategory {
  const norm = path.replace(/\\/g, '/').toLowerCase()
  for (const [key, cat] of Object.entries(CATEGORY_BY_DIR)) {
    if (norm.includes(`/${key}/`) || norm.includes(`\\${key}\\`)) return cat
  }
  return 'other'
}

function inferArchitecture(name: string): string | undefined {
  const n = name.toLowerCase()
  if (n.includes('sdxl') || n.includes('xl-base')) return 'SDXL'
  if (n.includes('sd3') || n.includes('sd-3')) return 'SD3'
  if (n.includes('flux')) return 'Flux'
  if (n.includes('wan')) return 'Wan'
  if (n.includes('hunyuan') || n.includes('hyvideo')) return 'Hunyuan'
  if (n.includes('qwen')) return 'Qwen'
  if (n.includes('ltx')) return 'LTX'
  if (n.includes('sd15') || n.includes('sd-1') || n.includes('v1-5')) return 'SD1.5'
  return undefined
}

function detectSourceFromPath(path: string): ModelRecord['source'] {
  const p = path.toLowerCase()
  if (p.includes('civitai')) return 'civitai'
  if (p.includes('huggingface') || p.includes('hf_')) return 'huggingface'
  return 'local'
}

/** Parse extra_model_paths.yaml and return all configured roots (including missing). */
export function parseExtraModelPaths(filePath?: string, includeMissing = true): string[] {
  const settings = loadSettings()
  const candidates = [filePath, settings.extraModelPathsFile].filter(Boolean) as string[]
  const roots: string[] = []
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue
    try {
      const doc = load(readFileSyncSafe(file)) as Record<string, Record<string, unknown>> | null
      if (!doc) continue
      for (const section of Object.values(doc)) {
        if (!section || typeof section !== 'object') continue
        for (const [key, val] of Object.entries(section)) {
          if (key === 'base_path' && typeof val === 'string') roots.push(val)
          if (
            [
              'checkpoints',
              'loras',
              'vae',
              'clip',
              'controlnet',
              'upscale_models',
              'embeddings',
              'unet',
              'diffusion_models',
              'text_encoders'
            ].includes(key) &&
            typeof val === 'string'
          ) {
            const base = typeof section.base_path === 'string' ? section.base_path : ''
            const full = val.match(/^[a-zA-Z]:[\\/]|^\//) ? val : join(base || dirname(file), val)
            if (includeMissing || existsSync(full)) roots.push(full)
          }
        }
      }
    } catch {
      /* ignore malformed yaml */
    }
  }
  return [...new Set(roots.map((r) => r.replace(/\\/g, '/')))]
}

function readFileSyncSafe(file: string): string {
  return readFileSync(file, 'utf-8')
}

/** Read safetensors header (first 8 bytes LE u64 + JSON). */
export function readSafetensorsMeta(filePath: string): Record<string, unknown> | null {
  try {
    const fd = openSync(filePath, 'r')
    const headerLenBuf = Buffer.alloc(8)
    readSync(fd, headerLenBuf, 0, 8, 0)
    const headerLen = Number(headerLenBuf.readBigUInt64LE(0))
    if (headerLen <= 0 || headerLen > 100 * 1024 * 1024) {
      closeSync(fd)
      return null
    }
    const jsonBuf = Buffer.alloc(Math.min(headerLen, 8 * 1024 * 1024))
    readSync(fd, jsonBuf, 0, jsonBuf.length, 8)
    closeSync(fd)
    const json = JSON.parse(jsonBuf.toString('utf-8').replace(/\0+$/, ''))
    const meta = json.__metadata__ || {}
    return { tensors: Object.keys(json).filter((k) => k !== '__metadata__').length, ...meta }
  } catch {
    return null
  }
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export class ModelService extends EventEmitter {
  private downloads = new Map<string, DownloadTask>()
  private abortControllers = new Map<string, AbortController>()

  list(): ModelRecord[] {
    return listModels()
  }

  storageStats(): StorageStats[] {
    const map = new Map<string, StorageStats>()
    let total = { category: 'total' as const, count: 0, bytes: 0 }
    for (const m of listModels()) {
      const s = map.get(m.category) || { category: m.category, count: 0, bytes: 0 }
      s.count += 1
      s.bytes += m.size
      map.set(m.category, s)
      total.count += 1
      total.bytes += m.size
    }
    return [...map.values(), total]
  }

  private walk(dir: string, out: string[], depth = 0): void {
    if (depth > 10 || out.length > 50000) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) this.walk(full, out, depth + 1)
        else if (MODEL_EXT.has(extname(name).toLowerCase())) out.push(full)
      } catch {
        /* skip */
      }
    }
  }

  async scan(opts?: { roots?: string[]; hash?: boolean }): Promise<ModelRecord[]> {
    const settings = loadSettings()
    const extraRoots = parseExtraModelPaths(undefined, false).filter((p) => existsSync(p))
    const scanRoots = (
      opts?.roots?.length ? opts.roots : [...settings.modelScanRoots, ...extraRoots]
    ).filter(Boolean)

    // Also auto-derive models/ under known instances
    const instanceModels = settings.defaultInstancePath
      ? [join(settings.defaultInstancePath, 'models')]
      : []
    const allRoots = [...new Set([...scanRoots, ...instanceModels])]

    const files: string[] = []
    for (const root of allRoots) {
      if (!existsSync(root)) continue
      const bucket: string[] = []
      this.walk(root, bucket)
      files.push(...bucket)
    }

    let scanned = 0
    for (const file of files) {
      scanned += 1
      this.emit('progress', {
        scanned,
        total: files.length,
        currentPath: file,
        phase: 'walk'
      } satisfies ModelScanProgress)

      try {
        const st = statSync(file)
        const id = createHash('sha1').update(file).digest('hex').slice(0, 16)
        const category = categorize(file)
        const existing = findModelByPath(file)
        let hash = existing?.hashSha256
        if (opts?.hash && !hash) {
          this.emit('progress', {
            scanned,
            total: files.length,
            currentPath: file,
            phase: 'hash'
          } satisfies ModelScanProgress)
          hash = await sha256File(file)
        }

        let metadata = existing?.metadata || {}
        let architecture = existing?.architecture
        let baseModel = existing?.baseModel
        let trainedWords = existing?.trainedWords || []
        if (extname(file).toLowerCase() === '.safetensors') {
          this.emit('progress', {
            scanned,
            total: files.length,
            currentPath: file,
            phase: 'meta'
          } satisfies ModelScanProgress)
          const meta = readSafetensorsMeta(file)
          if (meta) {
            metadata = { ...metadata, ...meta }
            const ss =
              meta.ss_base_model ||
              (meta.modelspec as Record<string, unknown> | undefined)?.architecture
            if (typeof ss === 'string') {
              baseModel = ss
              architecture = architecture || inferArchitecture(ss)
            }
            if (typeof meta.ss_tag_frequency === 'string') {
              try {
                trainedWords = Object.keys(JSON.parse(meta.ss_tag_frequency)).slice(0, 20)
              } catch {
                /* ignore */
              }
            }
          }
        }

        architecture = architecture || inferArchitecture(basename(file))
        const rec: ModelRecord = {
          id: existing?.id || id,
          name: parse(file).name,
          fileName: basename(file),
          category,
          path: file,
          size: st.size,
          hashSha256: hash,
          modifiedAt: st.mtimeMs,
          architecture,
          source: existing?.source || detectSourceFromPath(file),
          thumbnail: existing?.thumbnail,
          tags: existing?.tags || [],
          metadata,
          baseModel,
          trainedWords,
          duplicateOf: existing?.duplicateOf,
          pathRoot: allRoots.find((r) => file.startsWith(r)) || dirname(file)
        }
        upsertModel(rec)
      } catch {
        /* skip unreadable */
      }
    }

    // mark duplicates
    if (opts?.hash !== false) {
      this.markDuplicates()
    }

    this.emit('progress', {
      scanned: files.length,
      total: files.length,
      currentPath: '',
      phase: 'done'
    } satisfies ModelScanProgress)

    return this.list()
  }

  private markDuplicates(): void {
    const byHash = new Map<string, ModelRecord[]>()
    for (const m of listModels()) {
      if (!m.hashSha256) continue
      const arr = byHash.get(m.hashSha256) || []
      arr.push(m)
      byHash.set(m.hashSha256, arr)
    }
    for (const arr of byHash.values()) {
      if (arr.length < 2) {
        for (const m of arr) {
          if (m.duplicateOf) updateModel(m.id, { duplicateOf: '' })
        }
        continue
      }
      const primary = arr[0]
      for (let i = 1; i < arr.length; i++) {
        updateModel(arr[i].id, { duplicateOf: primary.path })
      }
    }
  }

  findDuplicates(): DuplicateGroup[] {
    const byHash = new Map<string, { files: string[]; size: number }>()
    for (const m of listModels()) {
      if (!m.hashSha256) continue
      const entry = byHash.get(m.hashSha256) || { files: [], size: m.size }
      entry.files.push(m.path)
      entry.size = m.size
      byHash.set(m.hashSha256, entry)
    }
    return [...byHash.entries()]
      .filter(([, v]) => v.files.length > 1)
      .map(([hash, v]) => ({ hash, size: v.size, files: v.files }))
  }

  async remove(id: string, deleteFile: boolean): Promise<boolean> {
    const models = listModels()
    const rec = models.find((m) => m.id === id)
    if (!rec) return false
    if (deleteFile && existsSync(rec.path)) unlinkSync(rec.path)
    return dbDeleteModel(id)
  }

  async move(id: string, destDir: string): Promise<ModelRecord> {
    const rec = listModels().find((m) => m.id === id)
    if (!rec) throw new Error('Model not found')
    mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, rec.fileName)
    if (existsSync(destPath) && destPath !== rec.path) {
      throw new Error(`Target already exists: ${destPath}`)
    }
    if (destPath === rec.path) return rec
    try {
      renameSync(rec.path, destPath)
    } catch (err) {
      // Cross-device: copy + unlink
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        const { copyFileSync, unlinkSync: ul } = await import('fs')
        copyFileSync(rec.path, destPath)
        ul(rec.path)
      } else {
        throw err
      }
    }
    dbDeleteModel(id)
    const next: ModelRecord = {
      ...rec,
      id: createHash('sha1').update(destPath).digest('hex').slice(0, 16),
      path: destPath,
      pathRoot: destDir
    }
    upsertModel(next)
    return next
  }

  async symlink(id: string, destDir: string): Promise<ModelRecord> {
    const rec = listModels().find((m) => m.id === id)
    if (!rec) throw new Error('Model not found')
    mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, rec.fileName)
    if (existsSync(destPath)) throw new Error(`Target already exists: ${destPath}`)
    symlinkSync(rec.path, destPath, 'file')
    const next: ModelRecord = {
      ...rec,
      id: createHash('sha1').update(destPath).digest('hex').slice(0, 16),
      path: destPath,
      pathRoot: destDir,
      source: 'imported'
    }
    upsertModel(next)
    return next
  }

  async rename(id: string, newName: string): Promise<ModelRecord> {
    const rec = listModels().find((m) => m.id === id)
    if (!rec) throw new Error('Model not found')
    updateModel(id, { name: newName })
    return { ...rec, name: newName }
  }

  async tag(id: string, tags: string[]): Promise<ModelRecord> {
    const rec = listModels().find((m) => m.id === id)
    if (!rec) throw new Error('Model not found')
    updateModel(id, { tags })
    return { ...rec, tags }
  }

  listDownloads(): DownloadTask[] {
    return this.downloads.size ? [...this.downloads.values()] : listDownloadTasks()
  }

  private detectDownloadSource(url: string): DownloadTask['source'] {
    if (url.includes('civitai.com')) return 'civitai'
    if (url.includes('huggingface.co') || url.includes('hf.co')) return 'huggingface'
    return 'direct'
  }

  async download(opts: {
    url: string
    destDir?: string
    fileName?: string
  }): Promise<DownloadTask> {
    const settings = loadSettings()
    const defaultDir = settings.downloadDir || join(homedir(), 'Downloads', 'ComfyPilot')
    let destDir = opts.destDir || defaultDir
    // Constrain destDir to known-safe roots (settings.downloadDir, default Downloads, model scan roots)
    {
      const { resolveInsideAnyRoot } = await import('./security')
      const allowedRoots = [
        settings.downloadDir,
        join(homedir(), 'Downloads'),
        ...settings.modelScanRoots,
        settings.defaultInstancePath && join(settings.defaultInstancePath, 'models')
      ].filter(Boolean) as string[]
      const safeDest = resolveInsideAnyRoot(destDir, allowedRoots)
      if (!safeDest) destDir = defaultDir
      else destDir = safeDest
    }
    mkdirSync(destDir, { recursive: true })
    let url = opts.url

    // Civitai download API redirect helper
    if (url.includes('civitai.com') && !url.includes('/api/download')) {
      const idMatch = url.match(/models\/(\d+)/)
      const verMatch = url.match(/modelVersionId=(\d+)/)
      if (idMatch) {
        const ver = verMatch?.[1]
        url = `https://civitai.com/api/download/models/${ver || idMatch[1]}`
      }
    }

    const rawName = opts.fileName || basename(new URL(url).pathname) || `download-${Date.now()}`
    const { assertSafeRelativeFilename } = await import('./security')
    const fileName = assertSafeRelativeFilename(rawName)
    const destPath = join(destDir, fileName)
    const id = createHash('sha1').update(url + destPath).digest('hex').slice(0, 12)
    const task: DownloadTask = {
      id,
      url,
      destPath,
      fileName,
      totalBytes: 0,
      receivedBytes: 0,
      status: 'queued',
      startedAt: Date.now(),
      source: this.detectDownloadSource(url)
    }
    this.downloads.set(id, task)
    upsertDownloadTask(task)
    this.emit('download', { ...task })
    void this.runDownload(task)
    return task
  }

  private async runDownload(task: DownloadTask, resume = false): Promise<void> {
    // Optional aria2 path (PLAN)
    const settings = loadSettings()
    if (settings.useAria2 && (settings.aria2Path || 'aria2c')) {
      try {
        const { aria2Service } = await import('./media')
        if (aria2Service.available()) {
          task.status = 'running'
          this.emit('download', { ...task })
          const res = await aria2Service.download(task.url, task.destPath)
          task.status = res.ok ? 'done' : 'error'
          task.error = res.ok ? undefined : res.log.slice(0, 300)
          task.finishedAt = Date.now()
          if (res.ok && existsSync(task.destPath)) {
            task.receivedBytes = statSync(task.destPath).size
            task.totalBytes = task.receivedBytes
          }
          upsertDownloadTask(task)
          this.emit('download', { ...task })
          return
        }
      } catch {
        /* fall back to native */
      }
    }

    const controller = new AbortController()
    this.abortControllers.set(task.id, controller)
    try {
      task.status = 'running'
      this.emit('download', { ...task })

      // Honour app proxy for raw fetch via undici/Node (env-based)
      const { proxyEnv, shouldBypass, buildBypassList, buildProxyUrl } = await import('./proxy')
      const psettings = loadSettings().proxy
      const env = proxyEnv(psettings)
      const useProxy =
        psettings.enabled &&
        buildProxyUrl(psettings) &&
        !shouldBypass(task.url, buildBypassList(psettings))
      // Node 18+ fetch: we can't pass proxy per-request easily; rely on env set globally
      if (useProxy) {
        process.env.HTTP_PROXY = env.HTTP_PROXY || process.env.HTTP_PROXY
        process.env.HTTPS_PROXY = env.HTTPS_PROXY || process.env.HTTPS_PROXY
      }

      const headers: Record<string, string> = {}
      let startByte = 0
      if (resume && existsSync(task.destPath)) {
        startByte = statSync(task.destPath).size
        if (startByte > 0) headers.Range = `bytes=${startByte}-`
      }

      const res = await fetch(task.url, { headers, signal: controller.signal })
      // 416 Range Not Satisfiable → file already fully downloaded
      if (resume && res.status === 416 && existsSync(task.destPath)) {
        task.status = 'done'
        task.receivedBytes = statSync(task.destPath).size
        task.totalBytes = task.receivedBytes
        task.finishedAt = Date.now()
        upsertDownloadTask(task)
        this.emit('download', { ...task })
        return
      }
      const isPartial = res.status === 206
      if (!res.ok && !isPartial) throw new Error(`HTTP ${res.status}`)

      // If server ignored Range and returned 200, we must NOT append — rewrite from 0.
      const appendMode = resume && startByte > 0 && isPartial
      if (resume && startByte > 0 && !isPartial) {
        startByte = 0
      }

      const contentLength = Number(res.headers.get('content-length') || 0)
      task.totalBytes = isPartial ? startByte + contentLength : contentLength || task.totalBytes
      task.receivedBytes = appendMode ? startByte : 0
      task.resumedFrom = appendMode ? startByte : undefined

      const mode = appendMode ? 'a' : 'w'
      const file = createWriteStream(task.destPath, { flags: mode as 'w' | 'a' })
      let streamClosed = false
      const closeStream = (): Promise<void> =>
        new Promise((resolve) => {
          if (streamClosed) return resolve()
          streamClosed = true
          try {
            file.end(() => resolve())
          } catch {
            try {
              file.destroy()
            } catch {
              /* ignore */
            }
            resolve()
          }
        })

      const reader = res.body?.getReader()
      if (!reader) {
        await closeStream()
        throw new Error('No response body')
      }
      let lastTick = Date.now()
      let windowBytes = 0

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          file.write(Buffer.from(value))
          task.receivedBytes += value.byteLength
          windowBytes += value.byteLength
          const now = Date.now()
          if (now - lastTick > 500) {
            task.speedBps = (windowBytes / (now - lastTick)) * 1000
            windowBytes = 0
            lastTick = now
            upsertDownloadTask(task)
            this.emit('download', { ...task })
          }
        }
      } finally {
        try {
          reader.cancel().catch(() => undefined)
        } catch {
          /* ignore */
        }
        await closeStream()
      }

      task.status = 'done'
      task.finishedAt = Date.now()
      task.speedBps = 0
      upsertDownloadTask(task)
    } catch (err) {
      const current = this.downloads.get(task.id)?.status ?? task.status
      if (current !== 'cancelled') {
        if (controller.signal.aborted) {
          task.status = 'paused'
        } else {
          task.status = 'error'
          task.error = err instanceof Error ? err.message : String(err)
        }
        task.finishedAt = Date.now()
        upsertDownloadTask(task)
      }
    } finally {
      this.abortControllers.delete(task.id)
    }
    this.emit('download', { ...task })
  }

  pauseDownload(id: string): DownloadTask {
    const task = this.downloads.get(id) || listDownloadTasks().find((t) => t.id === id)
    if (!task) throw new Error('Download not found')
    this.abortControllers.get(id)?.abort()
    task.status = 'paused'
    this.downloads.set(id, task)
    upsertDownloadTask(task)
    this.emit('download', { ...task })
    return task
  }

  async resumeDownload(id: string): Promise<DownloadTask> {
    const task = this.downloads.get(id) || listDownloadTasks().find((t) => t.id === id)
    if (!task) throw new Error('Download not found')
    task.status = 'queued'
    this.downloads.set(id, task)
    this.emit('download', { ...task })
    await this.runDownload(task, true)
    return task
  }

  cancelDownload(id: string): boolean {
    const task = this.downloads.get(id)
    if (task) {
      task.status = 'cancelled'
      task.error = 'cancelled'
    }
    this.abortControllers.get(id)?.abort()
    if (task) {
      upsertDownloadTask(task)
      this.emit('download', { ...task })
    }
    this.downloads.delete(id)
    this.abortControllers.delete(id)
    return true
  }

  async fetchCivitaiMeta(modelIdOrUrl: string): Promise<Record<string, unknown> | null> {
    try {
      const settings = loadSettings()
      const base = settings.civitaiEndpoint || 'https://civitai.com'
      let id = modelIdOrUrl
      const m = modelIdOrUrl.match(/models\/(\d+)/)
      if (m) id = m[1]
      const res = await fetch(`${base}/api/v1/models/${id}`, {
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) return null
      return (await res.json()) as Record<string, unknown>
    } catch {
      return null
    }
  }

  /** Storage analysis: bytes per top-level folder under model roots. */
  storageAnalysis(): StorageStats[] {
    return this.storageStats()
  }
}

export const modelService = new ModelService()
