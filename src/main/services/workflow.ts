import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { createHash } from 'crypto'
import type { WorkflowRecord } from '@shared/types'
import { loadSettings, upsertWorkflow, listWorkflows, loadInstanceConfigs } from './db'
import { ComfyApiClient } from './comfyApi'

function extractPngTextMeta(buf: Buffer): Record<string, unknown> {
  // PNG tEXt chunks: length(4) type(4) data crc(4)
  const meta: Record<string, unknown> = {}
  try {
    let offset = 8 // skip signature
    while (offset + 8 < buf.length) {
      const len = buf.readUInt32BE(offset)
      const type = buf.toString('ascii', offset + 4, offset + 8)
      if (type === 'tEXt' || type === 'iTXt') {
        const data = buf.toString('utf-8', offset + 8, offset + 8 + len)
        const nul = data.indexOf('\0')
        if (nul > 0) {
          const key = data.slice(0, nul)
          const value = data.slice(nul + 1)
          meta[key] = value
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

function parseWorkflowJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

export class WorkflowService {
  list(dir?: string): WorkflowRecord[] {
    const settings = loadSettings()
    const instances = loadInstanceConfigs()
    const roots = [
      dir,
      ...instances.map((i) => join(i.path, 'user', 'default', 'workflows')),
      join(settings.defaultInstancePath, 'user', 'default', 'workflows'),
      join(process.cwd(), 'workflows')
    ].filter(Boolean) as string[]

    const seen = new Set<string>()
    const out: WorkflowRecord[] = []

    for (const root of [...new Set(roots)]) {
      if (!root || !existsSync(root)) continue
      this.walk(root, out, seen, 0)
    }

    // persist
    for (const w of out) upsertWorkflow(w)
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private walk(dir: string, out: WorkflowRecord[], seen: Set<string>, depth: number): void {
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
          this.walk(full, out, seen, depth + 1)
          continue
        }
        const ext = extname(name).toLowerCase()
        if (!['.json', '.png'].includes(ext)) continue
        if (seen.has(full)) continue
        seen.add(full)

        let nodeCount = 0
        let description: string | undefined
        let missingNodes: string[] = []
        let format: WorkflowRecord['format'] = 'json'
        let seed: number | undefined
        let modelUsed: string | undefined
        let params: Record<string, unknown> = {}
        let version = '1.0'
        const id = createHash('sha1').update(full).digest('hex').slice(0, 16)

        if (ext === '.json') {
          const parsed = parseWorkflowJson(readFileSync(full, 'utf-8'))
          if (parsed) {
            const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : []
            nodeCount = nodes.length
            description = typeof parsed.name === 'string' ? parsed.name : undefined
            version = String(parsed.version || '1.0')
            missingNodes = (nodes as Array<{ type?: string }>)
              .filter((n) => typeof n?.type === 'string' && n.type.startsWith('Missing'))
              .map((n) => n.type as string)
            // collect widgets / seed-like params
            for (const n of nodes as Array<Record<string, unknown>>) {
              const w = n.widgets_values
              if (Array.isArray(w)) {
                for (const v of w) {
                  if (typeof v === 'number' && Number.isInteger(v) && v > 1 && v < 2 ** 32) {
                    seed = seed ?? v
                  }
                }
              }
              if (typeof n.title === 'string' && /model|checkpoint|unet/i.test(n.title)) {
                modelUsed = modelUsed || String(n.title)
              }
            }
            params = {
              nodeTypes: [...new Set((nodes as Array<{ type?: string }>).map((n) => n.type))].slice(0, 50)
            }
          }
        } else {
          format = 'png'
          const buf = readFileSync(full)
          const textMeta = extractPngTextMeta(buf)
          if (textMeta.prompt) {
            try {
              const prompt = JSON.parse(String(textMeta.prompt))
              nodeCount = Object.keys(prompt).length
              params = { promptKeys: Object.keys(prompt).slice(0, 30) }
            } catch {
              /* ignore */
            }
          }
          if (textMeta.workflow) {
            try {
              const wf = JSON.parse(String(textMeta.workflow))
              if (Array.isArray(wf.nodes)) nodeCount = wf.nodes.length
            } catch {
              /* ignore */
            }
          }
          if (textMeta.seed) seed = Number(textMeta.seed)
          if (textMeta.model) modelUsed = String(textMeta.model)
          params = { ...params, pngMeta: Object.keys(textMeta) }
        }

        out.push({
          id,
          name: basename(name, ext),
          path: full,
          format,
          nodeCount,
          tags: [],
          description,
          updatedAt: st.mtimeMs,
          missingNodes,
          version,
          seed,
          modelUsed,
          params
        })
      } catch {
        /* skip */
      }
    }
  }

  async importFile(path: string): Promise<WorkflowRecord> {
    const st = statSync(path)
    const id = createHash('sha1').update(path).digest('hex').slice(0, 16)
    const rec: WorkflowRecord = {
      id,
      name: basename(path, extname(path)),
      path,
      format: extname(path).toLowerCase() === '.png' ? 'png' : 'json',
      nodeCount: 0,
      tags: [],
      updatedAt: st.mtimeMs,
      missingNodes: [],
      version: '1.0',
      params: {}
    }
    upsertWorkflow(rec)
    this.list()
    return listWorkflows().find((w) => w.path === path) || rec
  }

  async tag(id: string, tags: string[]): Promise<WorkflowRecord> {
    const all = listWorkflows()
    const rec = all.find((w) => w.id === id || w.path === id)
    if (!rec) throw new Error('Workflow not found')
    const next = { ...rec, tags }
    upsertWorkflow(next)
    return next
  }

  async queue(opts: {
    workflowPath: string
    instanceId: string
    seed?: number
  }): Promise<string | null> {
    const instances = loadInstanceConfigs()
    const inst = instances.find((i) => i.id === opts.instanceId) || instances[0]
    if (!inst) throw new Error('No instance configured')
    const url = `http://${inst.listen === '0.0.0.0' ? '127.0.0.1' : inst.listen}:${inst.port}`
    const raw = readFileSync(opts.workflowPath, 'utf-8')
    let prompt: Record<string, unknown> | null = parseWorkflowJson(raw)

    // PNG embed → extract prompt graph (API format)
    if (extname(opts.workflowPath).toLowerCase() === '.png') {
      const buf = readFileSync(opts.workflowPath)
      const meta = extractPngTextMeta(buf)
      if (meta.prompt) {
        try {
          prompt = JSON.parse(String(meta.prompt))
        } catch {
          prompt = null
        }
      }
    }
    if (!prompt) throw new Error('Cannot parse workflow prompt')

    if (opts.seed != null) {
      for (const node of Object.values(prompt)) {
        const n = node as { class_type?: string; inputs?: Record<string, unknown> }
        if (n?.inputs && typeof n.inputs.seed === 'number') {
          n.inputs.seed = opts.seed
        }
      }
    }

    const client = new ComfyApiClient(url)
    return client.queuePrompt(prompt, `comfy-pilot-${Date.now()}`)
  }

  async parsePngMeta(path: string): Promise<Record<string, unknown> | null> {
    if (!existsSync(path)) return null
    const buf = readFileSync(path)
    return extractPngTextMeta(buf)
  }

  listCached(): WorkflowRecord[] {
    return listWorkflows()
  }
}

export const workflowService = new WorkflowService()

export { extractPngTextMeta, createReadStream, dirname }
