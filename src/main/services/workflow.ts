import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmSync,
  openSync,
  readSync,
  closeSync
} from 'fs'
import { join, extname, basename, dirname } from 'path'
import { createHash } from 'crypto'
import type { WorkflowRecord, WorkflowOrigin, ComfyInstanceConfig } from '@shared/types'
import {
  loadSettings,
  upsertWorkflow,
  upsertWorkflows,
  listWorkflows,
  updateWorkflow,
  deleteWorkflow as dbDeleteWorkflow,
  loadInstanceConfigs,
  workflowLibraryDir,
  userDataDir
} from './db'
import { ComfyApiClient } from './comfyApi'
import { assertSafeRelativeFilename, isPathInside } from './security'

// ---------- PNG metadata ----------

export function extractPngTextMeta(buf: Buffer): Record<string, unknown> {
  // PNG tEXt chunks: length(4) type(4) data crc(4)
  const meta: Record<string, unknown> = {}
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A — refuse non-PNG buffers.
  if (buf.length < 8 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    return meta
  }
  try {
    let offset = 8 // skip signature
    while (offset + 8 < buf.length) {
      const len = buf.readUInt32BE(offset)
      const type = buf.toString('ascii', offset + 4, offset + 8)
      const dataStart = offset + 8
      const dataEnd = dataStart + len
      if (type === 'tEXt') {
        const data = buf.toString('utf-8', dataStart, dataEnd)
        const nul = data.indexOf('\0')
        if (nul > 0) {
          meta[data.slice(0, nul)] = data.slice(nul + 1)
        }
      } else if (type === 'iTXt') {
        // keyword\0 flag method lang\0 transkey\0 text
        const data = buf.subarray(dataStart, dataEnd)
        const keyEnd = data.indexOf(0)
        if (keyEnd > 0) {
          const key = data.toString('utf-8', 0, keyEnd)
          let p = keyEnd + 3 // NUL + compression flag + compression method
          const langEnd = data.indexOf(0, p)
          if (langEnd >= 0) {
            p = langEnd + 1
            const transEnd = data.indexOf(0, p)
            if (transEnd >= 0) {
              meta[key] = data.toString('utf-8', transEnd + 1)
            }
          }
        }
      }
      if (type === 'IEND') break
      offset += 12 + len
    }
  } catch {
    /* ignore */
  }
  return meta
}

/**
 * tEXt/iTXt chunks sit near the head of a PNG — never slurp a full-size
 * output image just to read its metadata. Cap at 8MB so giant IDAT payloads
 * stay on disk while every normal ComfyUI PNG is covered.
 */
const PNG_META_READ_CAP = 8 * 1024 * 1024

export function readPngTextMetaFromFile(filePath: string): Record<string, unknown> {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const st = statSync(filePath)
    if (!st.size) return {}
    const cap = Math.min(st.size, PNG_META_READ_CAP)
    const buf = Buffer.alloc(cap)
    readSync(fd, buf, 0, cap, 0)
    return extractPngTextMeta(buf)
  } catch {
    return {}
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function parseWorkflowJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------- Analyze ----------

interface ParsedWorkflow {
  nodeCount: number
  description?: string
  missingNodes: string[]
  version: string
  seed?: number
  modelUsed?: string
  params: Record<string, unknown>
  /** API/UI graph payload extracted from JSON or PNG, when available. */
  graph: Record<string, unknown> | null
}

/**
 * Explicit seed/noise_seed on KSampler-like nodes — the most trustworthy
 * source. Returns undefined when no sampler node carries a seed field.
 */
function findSamplerSeed(nodes: Array<Record<string, unknown>>): number | undefined {
  const SAMPLER_TYPES =
    /KSampler|SamplerCustom|SamplerSelect|SamplerDPMPP|SamplerEuler|SamplerLCM|SamplerUniPC/i
  for (const n of nodes) {
    const type = String(n.type || n.class_type || '')
    if (!SAMPLER_TYPES.test(type)) continue
    // API form: { class_type, inputs: { seed | noise_seed } }
    const inputs = n.inputs as Record<string, unknown> | undefined
    if (inputs) {
      if (typeof inputs.seed === 'number' && Number.isFinite(inputs.seed)) return inputs.seed
      if (typeof inputs.noise_seed === 'number' && Number.isFinite(inputs.noise_seed)) {
        return inputs.noise_seed
      }
    }
    // UI form: widgets_values with seed/noise_seed at known positions.
    const w = n.widgets_values
    if (Array.isArray(w)) {
      // KSampler: [seed, control_after_generate, steps, cfg, ...]
      if (/^KSampler$/i.test(type) && typeof w[0] === 'number' && Number.isInteger(w[0])) {
        return w[0]
      }
      // KSamplerAdvanced: [add_noise, noise_seed, ...]
      if (/KSamplerAdvanced/i.test(type) && typeof w[1] === 'number' && Number.isInteger(w[1])) {
        return w[1]
      }
      // Generic: widgets metadata names a seed/noise_seed slot.
      const widgetNames = (n.widgets as Array<{ name?: string }> | undefined) || []
      for (let i = 0; i < widgetNames.length && i < w.length; i++) {
        const wn = String(widgetNames[i]?.name || '').toLowerCase()
        if ((wn === 'seed' || wn === 'noise_seed') && typeof w[i] === 'number') {
          return w[i]
        }
      }
    }
  }
  return undefined
}

/** Last-resort heuristic: first plausible integer in widgets_values. */
function findHeuristicSeed(nodes: Array<Record<string, unknown>>): number | undefined {
  for (const n of nodes) {
    const w = n.widgets_values
    if (!Array.isArray(w)) continue
    for (const v of w) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 1 && v < 2 ** 32) return v
    }
  }
  return undefined
}

function analyzeUiOrApiGraph(parsed: Record<string, unknown>): ParsedWorkflow {
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
  const nodeCount = nodes.length
  const description = typeof parsed.name === 'string' ? parsed.name : undefined
  const version = String(parsed.version || '1.0')
  const missingNodes = (nodes as Array<{ type?: string }>)
    .filter((n) => typeof n?.type === 'string' && n.type.startsWith('Missing'))
    .map((n) => n.type as string)
  let modelUsed: string | undefined
  // Seed priority: explicit sampler seed > heuristic first-integer.
  // PNG meta.seed is applied as a further fallback in analyzeFile().
  const samplerSeed = findSamplerSeed(nodes as Array<Record<string, unknown>>)
  const heuristicSeed = findHeuristicSeed(nodes as Array<Record<string, unknown>>)
  const seed = samplerSeed ?? undefined
  for (const n of nodes as Array<Record<string, unknown>>) {
    const w = n.widgets_values
    if (typeof n.title === 'string' && /model|checkpoint|unet/i.test(n.title)) {
      modelUsed = modelUsed || String(n.title)
    }
    // CheckpointLoaderSimple widgets_values[0] is the ckpt filename
    if (n.type === 'CheckpointLoaderSimple' && Array.isArray(w) && typeof w[0] === 'string') {
      modelUsed = modelUsed || String(w[0])
    }
    if (n.type === 'UNETLoader' && Array.isArray(w) && typeof w[0] === 'string') {
      modelUsed = modelUsed || String(w[0])
    }
  }
  return {
    nodeCount,
    description,
    missingNodes,
    version,
    seed,
    modelUsed,
    params: {
      nodeTypes: [...new Set((nodes as Array<{ type?: string }>).map((n) => n.type))].slice(0, 50),
      // Stashed so analyzeFile can fall back after PNG meta.seed.
      ...(heuristicSeed != null ? { heuristicSeed } : {})
    },
    graph: parsed
  }
}

function analyzeApiPrompt(prompt: Record<string, unknown>): ParsedWorkflow {
  const entries = Object.entries(prompt)
  // Prefer explicit seed/noise_seed on KSampler-like nodes; fall back to any
  // node's seed field (old behaviour) as the heuristic.
  const nodeValues = entries.map(([, v]) => v as Record<string, unknown>)
  const samplerSeed = findSamplerSeed(nodeValues)
  let seed: number | undefined = samplerSeed
  let modelUsed: string | undefined
  const missingNodes: string[] = []
  for (const [, node] of entries) {
    const n = node as { class_type?: string; inputs?: Record<string, unknown> }
    if (!n || typeof n !== 'object') continue
    const inputs = n.inputs || {}
    if (seed == null && typeof inputs.seed === 'number') seed = inputs.seed
    if (seed == null && typeof inputs.noise_seed === 'number') seed = inputs.noise_seed
    const ckpt = inputs.ckpt_name || inputs.unet_name || inputs.model_name
    if (typeof ckpt === 'string' && !modelUsed) modelUsed = ckpt
  }
  return {
    nodeCount: entries.length,
    missingNodes,
    version: '1.0',
    seed,
    modelUsed,
    params: {
      promptKeys: entries.map(([k]) => k).slice(0, 30),
      classTypes: [
        ...new Set(
          entries.map(([, v]) => (v as { class_type?: string })?.class_type).filter(Boolean)
        )
      ].slice(0, 50)
    },
    graph: prompt
  }
}

function analyzeParsedGraph(parsed: Record<string, unknown> | null): ParsedWorkflow {
  if (!parsed) {
    return { nodeCount: 0, missingNodes: [], version: '1.0', params: {}, graph: null }
  }
  if (Array.isArray(parsed.nodes)) return analyzeUiOrApiGraph(parsed)
  // API prompt form: { "1": { class_type, inputs } }
  const values = Object.values(parsed)
  const looksLikeApi =
    values.length > 0 &&
    values.every((v) => {
      const n = v as { class_type?: string; inputs?: unknown }
      return n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs != null
    })
  if (looksLikeApi) return analyzeApiPrompt(parsed)
  if (parsed.prompt && typeof parsed.prompt === 'object') {
    return analyzeParsedGraph(parsed.prompt as Record<string, unknown>)
  }
  if (parsed.workflow && typeof parsed.workflow === 'object') {
    return analyzeParsedGraph(parsed.workflow as Record<string, unknown>)
  }
  return { nodeCount: 0, missingNodes: [], version: '1.0', params: {}, graph: parsed }
}

/**
 * Reject anything that is not a recognisable ComfyUI workflow.
 * Accepts: UI graph `{nodes:[...]}`, API prompt `{id:{class_type,inputs}}`,
 * or the common wrappers `{workflow:...}` / `{prompt:...}`.
 */
function assertComfyWorkflow(graph: Record<string, unknown>): void {
  const check = (g: Record<string, unknown>): boolean => {
    if (Array.isArray(g.nodes)) return true
    const values = Object.values(g)
    if (
      values.length > 0 &&
      values.every((v) => {
        const n = v as { class_type?: string; inputs?: unknown }
        return n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs != null
      })
    ) {
      return true
    }
    if (
      g.workflow &&
      typeof g.workflow === 'object' &&
      check(g.workflow as Record<string, unknown>)
    ) {
      return true
    }
    if (g.prompt && typeof g.prompt === 'object' && check(g.prompt as Record<string, unknown>)) {
      return true
    }
    return false
  }
  if (!check(graph)) {
    throw new Error(
      'Not a ComfyUI workflow: expected a UI graph {nodes:[…]} or an API prompt {id:{class_type,inputs}}'
    )
  }
}

function analyzeFile(full: string, ext: string): ParsedWorkflow {
  if (ext === '.json') {
    const parsed = parseWorkflowJson(readFileSync(full, 'utf-8'))
    return analyzeParsedGraph(parsed)
  }
  // PNG: extract meta, prefer embedded workflow (UI) then prompt (API)
  const textMeta = readPngTextMetaFromFile(full)
  let graph: Record<string, unknown> | null = null
  if (textMeta.workflow) {
    graph = parseWorkflowJson(String(textMeta.workflow))
  }
  if (!graph && textMeta.prompt) {
    graph = parseWorkflowJson(String(textMeta.prompt))
  }
  const base = analyzeParsedGraph(graph)
  const heuristicSeed =
    typeof base.params.heuristicSeed === 'number' ? base.params.heuristicSeed : undefined
  const params: Record<string, unknown> = {
    ...base.params,
    pngMeta: Object.keys(textMeta)
  }
  // Seed priority: explicit sampler seed > PNG meta.seed > old heuristic.
  let seed = base.seed
  if (seed == null && textMeta.seed) {
    const n = Number(textMeta.seed)
    if (Number.isFinite(n)) seed = n
  }
  if (seed == null && heuristicSeed != null) seed = heuristicSeed
  let modelUsed = base.modelUsed
  if (!modelUsed && textMeta.model) modelUsed = String(textMeta.model)
  return {
    ...base,
    seed,
    modelUsed,
    params,
    graph
  }
}

function recordIdFor(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 16)
}

/**
 * (path,size,mtime) → analysis cache. list() rescans every file on each call;
 * unchanged files must not re-parse JSON / re-read PNG metadata.
 */
const analyzeCache = new Map<string, { size: number; mtimeMs: number; analyzed: ParsedWorkflow }>()

function analyzeCached(
  full: string,
  ext: string,
  st: { size: number; mtimeMs: number }
): ParsedWorkflow {
  const hit = analyzeCache.get(full)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.analyzed
  const analyzed = analyzeFile(full, ext)
  analyzeCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, analyzed })
  return analyzed
}

// ---------- Service ----------

export class WorkflowService {
  /** ComfyPilot library root (settings override or userData/data/workflows). */
  libraryRoot(): string {
    return workflowLibraryDir()
  }

  /**
   * Scan roots:
   *  1. ComfyPilot workflow library (always — this is where imports land)
   *  2. Each instance's `user/default/workflows`
   *  3. process.cwd()/workflows (dev convenience)
   *  4. optional explicit `dir`
   *
   * Returns the UNION of scanned files and DB records. DB-only rows whose file
   * vanished are marked `missing` so the UI can show/repair them instead of
   * silently dropping the user's import.
   */
  list(opts?: { includeMissing?: boolean }): WorkflowRecord[] {
    const instances = loadInstanceConfigs()
    const library = this.libraryRoot()
    const roots: Array<{ root: string; origin: WorkflowOrigin }> = [
      { root: library, origin: 'library' },
      ...instances.map((i) => ({
        root: join(i.path, 'user', 'default', 'workflows'),
        origin: 'instance' as WorkflowOrigin
      })),
      { root: join(process.cwd(), 'workflows'), origin: 'external' as WorkflowOrigin }
    ]

    const seen = new Set<string>()
    const scanned: WorkflowRecord[] = []
    for (const { root, origin } of roots) {
      if (!root || !existsSync(root)) continue
      this.walk(root, scanned, seen, 0, origin)
    }

    // Preserve user metadata (tags / favorite / description / importedAt) across rescans.
    const dbRows = listWorkflows()
    const dbById = new Map(dbRows.map((w) => [w.id, w]))
    const dbByPath = new Map(dbRows.map((w) => [w.path, w]))

    const out: WorkflowRecord[] = []
    const scannedPaths = new Set<string>()
    const scannedMerges: WorkflowRecord[] = []
    for (const rec of scanned) {
      scannedPaths.add(rec.path)
      const prev = dbById.get(rec.id) || dbByPath.get(rec.path)
      const merged: WorkflowRecord = {
        ...rec,
        // Keep the DB row's stable id when the path-hash differs (rename keeps
        // the original id so batch/output references stay valid).
        id: prev?.id ?? rec.id,
        tags: prev?.tags?.length ? prev.tags : rec.tags,
        favorite: prev?.favorite ?? rec.favorite,
        description: prev?.description ?? rec.description,
        importedAt: prev?.importedAt ?? rec.importedAt,
        sourcePath: prev?.sourcePath ?? rec.sourcePath,
        // Fresh analysis wins for derived keys; import-time markers
        // (extractedFrom etc.) must survive every rescan.
        params: { ...(prev?.params || {}), ...rec.params },
        missing: false
      }
      scannedMerges.push(merged)
      out.push(merged)
    }
    // One read-modify-write for the whole scan instead of one per file.
    upsertWorkflows(scannedMerges)

    // DB rows that no longer resolve to a file
    const missingMerges: WorkflowRecord[] = []
    for (const prev of listWorkflows()) {
      if (scannedPaths.has(prev.path)) continue
      if (seen.has(prev.path)) continue
      const exists = existsSync(prev.path)
      if (!exists) {
        const missingRec: WorkflowRecord = { ...prev, missing: true }
        missingMerges.push(missingRec)
        if (opts?.includeMissing !== false) out.push(missingRec)
        continue
      }
      // File exists but outside scan roots (user-imported external path) — keep visible.
      const recovered = this.buildRecord(prev.path, prev.origin || 'external', {
        ...prev
      })
      missingMerges.push(recovered)
      out.push(recovered)
    }
    upsertWorkflows(missingMerges)

    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private walk(
    dir: string,
    out: WorkflowRecord[],
    seen: Set<string>,
    depth: number,
    origin: WorkflowOrigin
  ): void {
    if (depth > 5) return
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
          this.walk(full, out, seen, depth + 1, origin)
          continue
        }
        const ext = extname(name).toLowerCase()
        if (!['.json', '.png'].includes(ext)) continue
        if (seen.has(full)) continue
        seen.add(full)
        out.push(this.buildRecord(full, origin))
      } catch {
        /* skip */
      }
    }
  }

  private buildRecord(
    full: string,
    origin: WorkflowOrigin,
    preserve?: Partial<WorkflowRecord>
  ): WorkflowRecord {
    const st = statSync(full)
    const ext = extname(full).toLowerCase()
    const analyzed = analyzeCached(full, ext, st)
    const id = recordIdFor(full)
    return {
      id,
      name: preserve?.name || basename(full, ext),
      path: full,
      format: ext === '.png' ? 'png' : 'json',
      nodeCount: analyzed.nodeCount,
      tags: preserve?.tags || [],
      description: analyzed.description ?? preserve?.description,
      updatedAt: st.mtimeMs,
      missingNodes: analyzed.missingNodes,
      version: analyzed.version,
      seed: analyzed.seed ?? preserve?.seed,
      modelUsed: analyzed.modelUsed ?? preserve?.modelUsed,
      // Keep import-time markers (extractedFrom etc.) across rescans.
      params: { ...(preserve?.params || {}), ...analyzed.params },
      origin,
      sourcePath: preserve?.sourcePath,
      favorite: preserve?.favorite,
      importedAt: preserve?.importedAt,
      missing: false
    }
  }

  /** Instance workflows folder — the place ComfyUI actually reads. */
  instanceWorkflowsDir(instanceId?: string): string {
    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === instanceId) || instances[0]
    if (!inst) throw new Error('No instance configured')
    return join(inst.path, 'user', 'default', 'workflows')
  }

  /**
   * True import: materialise EXACTLY ONE `.json` into the target folder.
   * - `target: 'instance'` (default) → instance `user/default/workflows` (ComfyUI loads it)
   * - `target: 'library'`            → ComfyPilot library root (`userData/workflows`)
   * - `.json` source → validated then written
   * - `.png` source  → embedded workflow/prompt extracted to `.json`
   *   (the PNG itself is NOT copied — one import = one JSON artifact)
   *
   * Anything that is not a recognisable ComfyUI workflow is REJECTED with a
   * clear reason. There is no silent "empty card" import.
   */
  async importFile(
    path: string,
    instanceId?: string,
    target: 'instance' | 'library' = 'instance'
  ): Promise<WorkflowRecord> {
    if (!existsSync(path)) throw new Error(`Workflow file not found: ${path}`)
    const st = statSync(path)
    if (!st.isFile()) throw new Error(`Not a file: ${path}`)

    const ext = extname(path).toLowerCase()
    if (!['.json', '.png'].includes(ext)) {
      throw new Error(`Unsupported workflow type: ${ext || '(none)'} — only .json / .png`)
    }

    // ---- parse + validate BEFORE touching disk ----
    let graph: Record<string, unknown>
    if (ext === '.png') {
      const meta = readPngTextMetaFromFile(path)
      const raw = String(meta.workflow || meta.prompt || '')
      const parsed = raw ? parseWorkflowJson(raw) : null
      if (!parsed) {
        throw new Error('Not a ComfyUI workflow: this PNG has no embedded workflow/prompt metadata')
      }
      graph = parsed
    } else {
      const parsed = parseWorkflowJson(readFileSync(path, 'utf-8'))
      if (!parsed) {
        throw new Error('Not a ComfyUI workflow: file is not valid JSON')
      }
      graph = parsed
    }
    // Throws with a descriptive message when the shape is wrong.
    assertComfyWorkflow(graph)

    // ---- land exactly one .json in the chosen folder ----
    const targetDir =
      target === 'library' ? this.libraryRoot() : this.instanceWorkflowsDir(instanceId)
    const origin: WorkflowOrigin = target === 'library' ? 'library' : 'instance'
    mkdirSync(targetDir, { recursive: true })
    const safeBase = assertSafeRelativeFilename(basename(path, ext)).slice(0, 120)
    let dest = join(targetDir, `${safeBase}.json`)
    let n = 1
    while (existsSync(dest) && !resolveSame(dest, path)) {
      dest = join(targetDir, `${safeBase}-${n}.json`)
      n += 1
      if (n > 200) throw new Error('Too many name collisions in the target workflows folder')
    }
    writeFileSync(dest, JSON.stringify(graph, null, 2), 'utf-8')

    const rec = this.buildRecord(dest, origin, {
      sourcePath: path,
      importedAt: Date.now(),
      name: safeBase,
      tags: [],
      favorite: false,
      params: ext === '.png' ? { extractedFrom: path } : {}
    })
    upsertWorkflow(rec)
    return rec
  }

  async importMany(
    paths: string[],
    instanceId?: string,
    target: 'instance' | 'library' = 'instance'
  ): Promise<{ ok: WorkflowRecord[]; errors: Array<{ path: string; message: string }> }> {
    const ok: WorkflowRecord[] = []
    const errors: Array<{ path: string; message: string }> = []
    for (const p of paths) {
      try {
        ok.push(await this.importFile(p, instanceId, target))
      } catch (e) {
        errors.push({ path: p, message: e instanceof Error ? e.message : String(e) })
      }
    }
    // Still throw when EVERY file failed so the caller sees a hard error.
    if (!ok.length && errors.length) {
      throw new Error(errors.map((e) => `${basename(e.path)}: ${e.message}`).join('; '))
    }
    return { ok, errors }
  }

  async tag(id: string, tags: string[]): Promise<WorkflowRecord> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id || w.path === id)
    if (!rec) throw new Error('Workflow not found')
    const next = { ...rec, tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))] }
    upsertWorkflow(next)
    return next
  }

  async favorite(id: string, favorite: boolean): Promise<WorkflowRecord> {
    const updated = updateWorkflow(id, { favorite })
    if (!updated) throw new Error('Workflow not found')
    return updated
  }

  async rename(id: string, name: string): Promise<WorkflowRecord> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    const safe = assertSafeRelativeFilename(name)
    const ext = extname(rec.path)
    const dir = dirname(rec.path)
    const dest = join(dir, `${safe}${ext}`)
    if (dest !== rec.path) {
      if (existsSync(dest)) throw new Error('Target name already exists')
      if (existsSync(rec.path)) renameSync(rec.path, dest)
    }
    // KEEP the original record id — changing it would orphan
    // batch.items[].workflowId and output_assets.workflowId references.
    const next: WorkflowRecord = {
      ...rec,
      name: safe,
      path: dest,
      updatedAt: Date.now()
    }
    // Replace the old row in place (same id) so list() does not resurrect a
    // stale path as missing.
    upsertWorkflow(next)
    return next
  }

  /**
   * Delete a workflow record.
   *
   * - library  → always deletes the file (ComfyPilot owns it)
   * - instance → deletes the source file too when `deleteSource` is true
   *              (default true — the user asked to support this)
   * - external → NEVER touches the file, unregister only
   *
   * A PNG import that produced a sibling .json is cleaned up as a pair.
   */
  async remove(id: string, opts?: { deleteSource?: boolean }): Promise<boolean> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) return false
    const library = this.libraryRoot()
    const isExternal = rec.origin === 'external'
    // External files are never ours to delete.
    const deleteSource = isExternal ? false : opts?.deleteSource !== false

    if (deleteSource && rec.path) {
      const inLibrary = rec.origin === 'library' && isPathInside(rec.path, library)
      const inInstance = rec.origin === 'instance'
      if (inLibrary || inInstance) {
        try {
          if (existsSync(rec.path)) unlinkSync(rec.path)
        } catch {
          /* keep going — DB row still removed */
        }
        // Only clean a true sibling INSIDE the same folder (legacy PNG↔JSON
        // pairs). `params.extractedFrom` points at the user's ORIGINAL source
        // and must never be deleted.
        const sibling = this.siblingPath(rec)
        if (sibling && dirname(sibling) === dirname(rec.path)) {
          const sibRec = all.find((w) => w.path === sibling)
          try {
            if (existsSync(sibling)) unlinkSync(sibling)
          } catch {
            /* ignore */
          }
          if (sibRec) dbDeleteWorkflow(sibRec.id)
        }
      }
    }
    return dbDeleteWorkflow(id)
  }

  /**
   * Same-folder `.json`/`.png` counterpart of a legacy pair.
   * NEVER returns `params.extractedFrom` — that is the original source file
   * outside the target folder and deleting it would destroy user data.
   */
  private siblingPath(rec: WorkflowRecord): string | null {
    const p = rec.path
    if (/\.png$/i.test(p)) {
      const j = p.replace(/\.png$/i, '.json')
      return existsSync(j) ? j : null
    }
    if (/\.json$/i.test(p)) {
      const png = p.replace(/\.json$/i, '.png')
      return existsSync(png) ? png : null
    }
    return null
  }

  /** Zip the workflow (json preferred, else png) + optional notes into destDir. */
  async exportZip(id: string, destDir?: string): Promise<{ path: string }> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    if (!existsSync(rec.path)) throw new Error('Workflow file missing on disk')

    const targetDir = destDir || this.libraryRoot()
    mkdirSync(targetDir, { recursive: true })
    const zipPath = join(targetDir, `${assertSafeRelativeFilename(rec.name)}.zip`)

    // Prefer a real JSON payload for portability.
    let payloadPath = rec.path
    let payloadName = basename(rec.path)
    let tmpJson: string | null = null
    if (rec.format === 'png') {
      const meta = readPngTextMetaFromFile(rec.path)
      const raw = String(meta.workflow || meta.prompt || '')
      const parsed = raw ? parseWorkflowJson(raw) : null
      if (parsed) {
        // Write the extracted JSON to a temp dir — NOT the export target —
        // so the library root is never polluted with stray .json files.
        const os = await import('os')
        const tmpDir = join(os.tmpdir(), 'comfypilot-export-' + Date.now())
        mkdirSync(tmpDir, { recursive: true })
        tmpJson = join(tmpDir, `${assertSafeRelativeFilename(rec.name)}.json`)
        writeFileSync(tmpJson, JSON.stringify(parsed, null, 2), 'utf-8')
        payloadPath = tmpJson
        payloadName = basename(tmpJson)
      }
    }

    const { createWorkflowZip } = await import('./zipWrite')
    await createWorkflowZip(zipPath, [
      { path: payloadPath, name: payloadName },
      {
        name: 'README.txt',
        content:
          `ComfyPilot workflow export\n` +
          `Name: ${rec.name}\n` +
          `Version: ${rec.version}\n` +
          `Nodes: ${rec.nodeCount}\n` +
          `Tags: ${(rec.tags || []).join(', ') || '(none)'}\n` +
          (rec.sourcePath ? `Source: ${rec.sourcePath}\n` : '')
      }
    ])
    // Clean up the temp extraction directory.
    if (tmpJson) {
      try {
        rmSync(dirname(tmpJson), { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    return { path: zipPath }
  }

  /** Copy a workflow into a ComfyUI instance's user/default/workflows. */
  async copyToInstance(id: string, instanceId: string): Promise<{ path: string }> {
    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === instanceId) || instances[0]
    if (!inst) throw new Error('No instance configured')
    return this.copyToInstancePath(id, inst)
  }

  private copyToInstancePath(id: string, inst: ComfyInstanceConfig): { path: string } {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    if (!existsSync(rec.path)) throw new Error('Workflow file missing on disk')

    const destDir = join(inst.path, 'user', 'default', 'workflows')
    mkdirSync(destDir, { recursive: true })
    const ext = extname(rec.path)
    const safe = assertSafeRelativeFilename(rec.name)
    const srcHash = hash8(rec.path)

    // 1) Preferred name: reuse when content is identical (openInFrontend on
    //    every click must NOT keep minting foo-1.json, foo-2.json...).
    const preferred = join(destDir, `${safe}${ext}`)
    if (existsSync(preferred)) {
      if (resolveSame(preferred, rec.path) || sameContentHash(preferred, rec.path)) {
        return { path: preferred }
      }
      // 2) Name collision with DIFFERENT content: stable name derived from the
      //    source content hash (not an incrementing counter) so re-copies land
      //    on the same file instead of accumulating duplicates.
      const hashed = join(destDir, `${safe}.${srcHash}${ext}`)
      if (existsSync(hashed)) {
        if (resolveSame(hashed, rec.path) || sameContentHash(hashed, rec.path)) {
          return { path: hashed }
        }
        // Same stable name but content drifted — overwrite (we own this slot).
        copyFileSync(rec.path, hashed)
        return { path: hashed }
      }
      copyFileSync(rec.path, hashed)
      return { path: hashed }
    }
    copyFileSync(rec.path, preferred)
    return { path: preferred }
  }

  /**
   * Copy the workflow into the target instance's library and report the
   * Frontend URL. Does NOT open anything — the IPC layer starts the instance
   * (if needed) and opens embed/browser so a stopped instance never yields a
   * dead "opened Frontend" toast.
   */
  async prepareFrontend(
    id: string,
    instanceId?: string
  ): Promise<{ instanceId: string; instanceName: string; url: string; copiedPath: string }> {
    const instances = loadInstanceConfigs()
    const inst =
      instances.find((i) => i.id === instanceId) ||
      instances.find(
        (i) => i.id === (loadSettings() as { activeInstance?: string }).activeInstance
      ) ||
      instances[0]
    if (!inst) throw new Error('No instance configured')

    const copied = this.copyToInstancePath(id, inst)
    const host =
      inst.listen === '0.0.0.0' || inst.listen === '::' || inst.listen === '[::]'
        ? '127.0.0.1'
        : inst.listen
    const url = `http://${host}:${inst.port}`
    return {
      instanceId: inst.id,
      instanceName: inst.name,
      url,
      copiedPath: copied.path
    }
  }

  async reveal(id: string): Promise<boolean> {
    const rec = listWorkflows().find((w) => w.id === id)
    if (!rec) throw new Error('Workflow not found')
    const { shell } = await import('electron')
    shell.showItemInFolder(rec.path)
    return true
  }

  libraryInfo(instanceId?: string): {
    root: string
    instanceName: string
    count: number
    missing: number
  } {
    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === instanceId) || instances[0]
    // root = where imports land (instance workflows dir when available)
    const root = inst ? join(inst.path, 'user', 'default', 'workflows') : this.libraryRoot()
    const all = this.list({ includeMissing: true })
    return {
      root,
      instanceName: inst?.name || '',
      count: all.filter((w) => !w.missing).length,
      missing: all.filter((w) => w.missing).length
    }
  }

  async queue(opts: {
    workflowPath: string
    instanceId: string
    seed?: number
  }): Promise<string | null> {
    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === opts.instanceId) || instances[0]
    if (!inst) throw new Error('No instance configured')
    // Same host normalisation as p1p2.instanceUrl — IPv6 listeners included.
    const host =
      inst.listen === '0.0.0.0' || inst.listen === '::' || inst.listen === '[::]'
        ? '127.0.0.1'
        : inst.listen
    const url = `http://${host}:${inst.port}`

    let rawJson: unknown = null
    const ext = extname(opts.workflowPath).toLowerCase()
    if (ext === '.png') {
      const meta = readPngTextMetaFromFile(opts.workflowPath)
      if (meta.prompt) {
        try {
          rawJson = JSON.parse(String(meta.prompt))
        } catch {
          rawJson = null
        }
      }
      if (!rawJson && meta.workflow) {
        try {
          rawJson = JSON.parse(String(meta.workflow))
        } catch {
          rawJson = null
        }
      }
    } else {
      rawJson = parseWorkflowJson(readFileSync(opts.workflowPath, 'utf-8'))
    }
    if (!rawJson) throw new Error('Cannot parse workflow prompt')

    const { toApiPrompt, applySeedToPrompt } = await import('./workflowConvert')
    let prompt = toApiPrompt(rawJson)
    if (opts.seed != null) prompt = applySeedToPrompt(prompt, opts.seed)

    const client = new ComfyApiClient(url)
    const { COMFY_CLIENT_ID } = await import('./comfyApi')
    // queuePrompt throws with ComfyUI's error body on rejection — propagate it.
    const promptId = await client.queuePrompt(prompt, COMFY_CLIENT_ID)
    if (!promptId) {
      throw new Error('ComfyUI accepted the prompt but returned no prompt_id')
    }
    // Sidecar map: lets OutputService.walk attribute the later output files
    // to this workflow even when PNG meta lacks the workflow id.
    try {
      const wf = listWorkflows().find((w) => w.path === opts.workflowPath)
      recordPromptWorkflowLink(promptId, wf?.id, wf?.name)
    } catch {
      /* best-effort */
    }
    return promptId
  }

  async parsePngMeta(path: string): Promise<Record<string, unknown> | null> {
    if (!existsSync(path)) return null
    // PNG only — never slurp videos/audio into memory looking for tEXt chunks.
    if (!/\.png$/i.test(path)) return null
    const st = statSync(path)
    if (!st.size) return null
    // tEXt/iTXt live near the head; readPngTextMetaFromFile caps the read.
    return readPngTextMetaFromFile(path)
  }

  listCached(): WorkflowRecord[] {
    return listWorkflows()
  }
}

// ---------- promptId -> workflowId sidecar map ----------
// Lets OutputService.walk attribute single-shot queue outputs to the workflow
// that produced them (PNG meta may lack the workflow id).

function promptLinksPath(): string {
  return join(userDataDir(), 'prompt_links.jsonc')
}

interface PromptWorkflowLink {
  workflowId?: string
  workflowName?: string
}

function loadPromptLinks(): Record<string, PromptWorkflowLink> {
  try {
    const p = promptLinksPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, PromptWorkflowLink>
  } catch {
    return {}
  }
}

function savePromptLinks(map: Record<string, PromptWorkflowLink>): void {
  try {
    writeFileSync(promptLinksPath(), JSON.stringify(map, null, 2), 'utf-8')
  } catch {
    /* best-effort */
  }
}

/** Record promptId -> workflow linkage so walk() can backfill workflowId. */
export function recordPromptWorkflowLink(
  promptId: string,
  workflowId?: string,
  workflowName?: string
): void {
  if (!promptId) return
  const map = loadPromptLinks()
  map[promptId] = { workflowId, workflowName }
  // Cap growth: drop the oldest half once past 2000 entries.
  const keys = Object.keys(map)
  if (keys.length > 2000) {
    for (const k of keys.slice(0, 500)) delete map[k]
  }
  savePromptLinks(map)
}

/** Look up workflow linkage for a promptId recorded at queue time. */
export function lookupPromptWorkflowLink(promptId: string): PromptWorkflowLink | undefined {
  if (!promptId) return undefined
  return loadPromptLinks()[promptId]
}

function resolveSame(a: string, b: string): boolean {
  try {
    // Only Windows and macOS default to case-insensitive paths.
    const fold = process.platform === 'win32' || process.platform === 'darwin'
    const key = (p: string) => (fold ? p.toLowerCase() : p)
    return key(a) === key(b)
  } catch {
    return false
  }
}

/** Short content hash for stable collision names. */
function hash8(filePath: string): string {
  try {
    return createHash('sha1').update(readFileSync(filePath)).digest('hex').slice(0, 8)
  } catch {
    return createHash('sha1').update(filePath).digest('hex').slice(0, 8)
  }
}

/** True when both files have identical content (by hash). */
function sameContentHash(a: string, b: string): boolean {
  if (resolveSame(a, b)) return true
  try {
    return hash8(a) === hash8(b)
  } catch {
    return false
  }
}

export const workflowService = new WorkflowService()
