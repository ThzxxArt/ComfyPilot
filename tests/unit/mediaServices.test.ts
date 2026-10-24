/**
 * media.ts coverage: thumbnail pipeline, media URL gate expansion,
 * RenameService.batchRename, Aria2Service download.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync
} from 'fs'
import { join, dirname, basename } from 'path'
import { createHash } from 'crypto'
import type { ModelRecord } from '../../src/shared/types'

const h = vi.hoisted(() => ({
  execImpl: null as
    | null
    | ((
        cmd: string,
        args: string[],
        cb: (e: Error | null, o: string, s: string) => void
      ) => unknown),
  pendingAborts: [] as Array<() => void>,
  hang: false,
  readFileSyncImpl: null as null | ((...a: unknown[]) => unknown),
  writeFileSyncImpl: null as null | ((...a: unknown[]) => unknown),
  renameSyncImpl: null as null | ((...a: unknown[]) => unknown),
  actualReadFileSync: null as null | ((...a: unknown[]) => unknown),
  // 0.1.18 (CI fix): every worker used the SAME app.getPath() dir. db caches
  // invalidate on external mtime changes, so parallel test files sharing the
  // models file could load each other's (empty) list and `ensureAll()` saw no
  // models. Give each worker its own root.
  root: `${
    process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp'
  }/cp-media-svc-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  h.actualReadFileSync = actual.readFileSync as never
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: unknown[]) =>
      h.readFileSyncImpl
        ? h.readFileSyncImpl(...args)
        : (actual.readFileSync as (...a: unknown[]) => unknown)(...args),
    writeFileSync: (...args: unknown[]) =>
      h.writeFileSyncImpl
        ? h.writeFileSyncImpl(...args)
        : (actual.writeFileSync as (...a: unknown[]) => unknown)(...args),
    renameSync: (...args: unknown[]) =>
      h.renameSyncImpl
        ? h.renameSyncImpl(...args)
        : (actual.renameSync as (...a: unknown[]) => unknown)(...args)
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => h.root },
  nativeImage: {
    createFromPath: (p: string) => ({
      isEmpty: () => !existsSync(p) || p.includes('broken'),
      getSize: () =>
        p.includes('small') ? { width: 80, height: 60 } : { width: 640, height: 480 },
      resize: () => ({ toPNG: () => Buffer.from('resized-png') }),
      toPNG: () => Buffer.from('resized-png')
    })
  },
  session: {
    defaultSession: {
      // Delegate to the CURRENT global fetch so vi.stubGlobal('fetch', …)
      // after module load is still honored (proxyFetch routes through here).
      fetch: (url: unknown, init?: unknown) => {
        const f = (globalThis as Record<string, unknown>).fetch as
          ((u: unknown, i?: unknown) => Promise<unknown>) | undefined
        return f ? f(url, init) : Promise.reject(new Error('no fetch'))
      },
      setProxy: async () => undefined
    }
  }
}))

vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: Error | null, o: string, s: string) => void
  ): { pid: number; exitCode: number | null; kill: () => void } => {
    const child = {
      pid: 777,
      exitCode: null as number | null,
      kill: () => undefined
    }
    const deliver = (): void => {
      if (h.execImpl) h.execImpl(String(cmd), args, cb)
      else cb(null, 'downloaded', '')
    }
    if (h.hang) h.pendingAborts.push(deliver)
    else queueMicrotask(deliver)
    return child
  },
  spawn: () => ({ pid: 1, exitCode: null, kill: () => undefined })
}))

const ROOT = h.root

function rec(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: 'm1',
    name: 'MyModel',
    fileName: 'MyModel.safetensors',
    category: 'checkpoints',
    path: join(ROOT, 'models', 'MyModel.safetensors'),
    size: 100,
    modifiedAt: Date.now(),
    source: 'local',
    tags: [],
    metadata: {},
    trainedWords: [],
    pathRoot: join(ROOT, 'models'),
    ...overrides
  }
}

async function freshMedia(): Promise<typeof import('../../src/main/services/media')> {
  vi.resetModules()
  return import('../../src/main/services/media')
}

describe('media services', () => {
  beforeAll(() => {
    mkdirSync(join(ROOT, 'models'), { recursive: true })
    mkdirSync(join(ROOT, 'out'), { recursive: true })
  })

  beforeEach(() => {
    h.execImpl = null
    h.hang = false
    h.pendingAborts = []
    h.readFileSyncImpl = null
    h.writeFileSyncImpl = null
    h.renameSyncImpl = null
    // purge cached thumbs so ensureModelThumb cannot early-return from a prior run
    rmSync(join(ROOT, 'cache', 'thumbs'), { recursive: true, force: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ---------- ThumbnailService ----------

  describe('ThumbnailService.ensureModelThumb', () => {
    it('reuses an existing cached thumb', async () => {
      const media = await freshMedia()
      const { cacheDir } = await import('../../src/main/services/db')
      const thumbs = join(cacheDir(), 'thumbs')
      mkdirSync(thumbs, { recursive: true })
      const cached = join(thumbs, 'm-cached.png')
      writeFileSync(cached, 'cached')
      const out = await media.thumbnailService.ensureModelThumb(rec({ id: 'm-cached' }))
      expect(out).toBe(cached)
    })

    it('copies sidecar preview.png / .png / .jpg and marks the record', async () => {
      const media = await freshMedia()
      const { upsertModel, listModels, deleteModel } = await import('../../src/main/services/db')
      const base = join(ROOT, 'models', 'sidecar-model')
      writeFileSync(base + '.safetensors', 'x')
      for (const [id, side] of [
        ['sc1', `${base}.preview.png`],
        ['sc2', `${base}.png`],
        ['sc3', `${base}.jpg`]
      ] as const) {
        writeFileSync(side, 'img-bytes')
        const r = rec({ id, path: base + '.safetensors', fileName: 'sidecar-model.safetensors' })
        upsertModel(r)
        const out = await media.thumbnailService.ensureModelThumb(r)
        expect(out).toBeTruthy()
        expect(existsSync(out!)).toBe(true)
        expect(readFileSync(out!)).toEqual(Buffer.from('img-bytes'))
        const saved = listModels().find((m) => m.id === id)
        expect(saved?.thumbnail).toBe(out)
        deleteModel(id)
        rmSync(out!, { force: true })
      }
    })

    it('falls through when sidecar read fails, then uses civitai image', async () => {
      const media = await freshMedia()
      const { upsertModel, deleteModel } = await import('../../src/main/services/db')
      const p = join(ROOT, 'models', 'civ-model.safetensors')
      writeFileSync(p, 'x')
      writeFileSync(join(ROOT, 'models', 'civ-model.preview.png'), 'x')
      const { cacheDir } = await import('../../src/main/services/db')
      rmSync(join(cacheDir(), 'thumbs', 'civ1.png'), { force: true })
      const r = rec({
        id: 'civ1',
        path: p,
        fileName: 'civ-model.safetensors',
        source: 'civitai',
        metadata: { civitai: { images: [{ url: 'https://civitai.example/img.png' }] } }
      })
      upsertModel(r)
      // make readFileSync throw for the sidecar only
      h.readFileSyncImpl = ((f: unknown, ...rest: unknown[]) => {
        if (String(f).endsWith('civ-model.preview.png')) throw new Error('EACCES')
        return (h.actualReadFileSync as (...a: unknown[]) => unknown)(f, ...rest)
      }) as never

      const fetchSpy = vi.fn(async () => new Response(Buffer.from('civ-img'), { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)

      const out = await media.thumbnailService.ensureModelThumb(r)
      h.readFileSyncImpl = null
      expect(out).toBeTruthy()
      expect(fetchSpy).toHaveBeenCalled()
      expect(readFileSync(out!)).toEqual(Buffer.from('civ-img'))
      deleteModel('civ1')
      rmSync(out!, { force: true })
    })

    it('civitai fetch non-ok / throw / missing url fall through to SVG', async () => {
      const media = await freshMedia()
      const p = join(ROOT, 'models', 'svg-model.safetensors')
      writeFileSync(p, 'x')

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('no', { status: 500 }))
      )
      const r1 = rec({
        id: 'svg1',
        path: p,
        source: 'civitai',
        metadata: { civitai: { images: [{ url: 'https://civitai.example/a.png' }] } }
      })
      const out1 = await media.thumbnailService.ensureModelThumb(r1)
      expect(out1!.endsWith('.svg')).toBe(true)
      expect(readFileSync(out1!, 'utf-8')).toContain('<svg')
      rmSync(out1!, { force: true })

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('net down')
        })
      )
      const r2 = rec({ id: 'svg2', path: p, source: 'civitai', metadata: { civitai: {} } })
      const out2 = await media.thumbnailService.ensureModelThumb(r2)
      expect(out2!.endsWith('.svg')).toBe(true)
      rmSync(out2!, { force: true })

      vi.stubGlobal('fetch', vi.fn())
      const r3 = rec({ id: 'svg3', path: p, source: 'local', metadata: {} })
      const out3 = await media.thumbnailService.ensureModelThumb(r3)
      expect(out3!.endsWith('.svg')).toBe(true)
      rmSync(out3!, { force: true })
    })

    it('returns null when placeholder write fails', async () => {
      const media = await freshMedia()
      h.writeFileSyncImpl = () => {
        throw new Error('disk full')
      }
      const out = await media.thumbnailService.ensureModelThumb(
        rec({ id: 'svg-fail', path: join(ROOT, 'models', 'nofile.safetensors') })
      )
      h.writeFileSyncImpl = null
      expect(out).toBeNull()
    })

    it('ensureAll generates thumbs for models without one and skips existing', async () => {
      const media = await freshMedia()
      const { upsertModel, deleteModel } = await import('../../src/main/services/db')
      const { cacheDir } = await import('../../src/main/services/db')
      const thumbs = join(cacheDir(), 'thumbs')
      mkdirSync(thumbs, { recursive: true })
      const existingThumb = join(thumbs, 'ea-has.png')
      writeFileSync(existingThumb, 'x')

      const p1 = join(ROOT, 'models', 'ea1.safetensors')
      const p2 = join(ROOT, 'models', 'ea2.safetensors')
      writeFileSync(p1, 'x')
      writeFileSync(p2, 'x')
      // Distinct paths: upsert merges records that share a path, which used to
      // turn these two fixtures into one (already-thumbnailed) row.
      upsertModel(rec({ id: 'ea-has', path: p1, thumbnail: existingThumb }))
      upsertModel(rec({ id: 'ea-need', path: p2 }))
      const n = await media.thumbnailService.ensureAll()
      expect(n).toBeGreaterThanOrEqual(1)
      deleteModel('ea-has')
      deleteModel('ea-need')
    })

    it('cacheRoot / thumbPathFor build under thumbs/', async () => {
      const media = await freshMedia()
      const root = media.thumbnailService.cacheRoot()
      expect(root).toContain('thumbs')
      expect(media.thumbnailService.thumbPathFor('abc')).toBe(join(root, 'abc.png'))
    })
  })

  // ---------- toMediaUrl / resolveMediaUrlToPath / thumbnailDisplayUrl ----------

  describe('media URL gate expansion', () => {
    it('maps output-root files including nested folders', async () => {
      const media = await freshMedia()
      const { upsertInstanceConfig } = await import('../../src/main/services/db')
      const instOut = join(ROOT, 'inst', 'output')
      mkdirSync(join(instOut, 'sub', 'dir'), { recursive: true })
      const nested = join(instOut, 'sub', 'dir', 'pic.png')
      writeFileSync(nested, 'x')

      upsertInstanceConfig({
        id: 'media-inst',
        name: 'M',
        path: join(ROOT, 'inst'),
        pythonPath: '',
        venvPath: '',
        port: 8188,
        listen: '127.0.0.1',
        extraArgs: [],
        argTemplateId: 'default',
        enabled: true,
        notes: '',
        autoStart: false,
        frontendVersion: '',
        pinned: false
      })
      const url = media.toMediaUrl(nested)
      expect(url).toBe('comfy-pilot-media:output/sub/dir/pic.png')
      expect(media.resolveMediaUrlToPath(url!)).toBe(nested)
    })

    it('honors --output-directory for instance media roots', async () => {
      const media = await freshMedia()
      const { upsertInstanceConfig } = await import('../../src/main/services/db')
      const instRoot = join(ROOT, 'custom-out-inst')
      const custom = join(instRoot, 'custom_output')
      mkdirSync(custom, { recursive: true })
      const img = join(custom, 'pic.png')
      writeFileSync(img, 'x')
      upsertInstanceConfig({
        id: 'custom-out',
        name: 'C',
        path: instRoot,
        pythonPath: '',
        venvPath: '',
        port: 8189,
        listen: '127.0.0.1',
        extraArgs: ['--output-directory', 'custom_output'],
        argTemplateId: 'default',
        enabled: true,
        notes: '',
        autoStart: false,
        frontendVersion: '',
        pinned: false
      })
      const url = media.toMediaUrl(img)
      expect(url).toBe('comfy-pilot-media:output/pic.png')
      expect(media.resolveMediaUrlToPath(url!)).toBe(img)
    })

    it('rejects empty path, bad ext, and throws-to-null', async () => {
      const media = await freshMedia()
      expect(media.toMediaUrl('')).toBeNull()
      expect(media.toMediaUrl(join(ROOT, 'x.txt'))).toBeNull()
      // extname of a weird path still runs; catch path via invalid type
      expect(media.toMediaUrl(null as unknown as string)).toBeNull()
    })

    it('resolveMediaUrlToPath rejects traversal, empty output rel, bad ext, missing file', async () => {
      const media = await freshMedia()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:thumbs/..%2F..%2Fx.png')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:thumbs/')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:thumbs/a.exe')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:thumbs/nope-missing.png')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:output/')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:output/../x.png')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:output/a/b.txt')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:output/missing/nope.png')).toBeNull()
      expect(media.resolveMediaUrlToPath('comfy-pilot-media:thumbs/%E0%A4%A')).toBeNull()
    })

    it('thumbnailDisplayUrl passthrough / convert / null', async () => {
      const media = await freshMedia()
      expect(media.thumbnailDisplayUrl(undefined)).toBeNull()
      expect(media.thumbnailDisplayUrl('comfy-pilot-media:thumbs/x.png')).toBe(
        'comfy-pilot-media:thumbs/x.png'
      )
      const { cacheDir } = await import('../../src/main/services/db')
      const thumbs = join(cacheDir(), 'thumbs')
      mkdirSync(thumbs, { recursive: true })
      const f = join(thumbs, 'disp.png')
      writeFileSync(f, 'x')
      expect(media.thumbnailDisplayUrl(f)).toBe('comfy-pilot-media:thumbs/disp.png')
    })
  })

  // ---------- RenameService ----------

  describe('RenameService.batchRename', () => {
    it('reports not-found, same-path, dryRun, illegal name, reserved name, target exists, happy path', async () => {
      const media = await freshMedia()
      const { upsertModel, listModels, deleteModel } = await import('../../src/main/services/db')

      // not found
      let results = media.renameService.batchRename(['ghost-id'], '{name}', true)
      expect(results[0]).toMatchObject({ ok: false, error: 'not found' })

      const dir = join(ROOT, 'models', 'rename-me')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const p1 = join(dir, 'alpha.safetensors')
      writeFileSync(p1, 'x')
      const r1 = rec({
        id: 'rn-alpha',
        name: 'alpha',
        fileName: 'alpha.safetensors',
        path: p1,
        architecture: 'sdxl'
      })
      upsertModel(r1)

      // same path (pattern produces identical base)
      results = media.renameService.batchRename(['rn-alpha'], 'alpha', true)
      expect(results[0].ok).toBe(true)
      expect(results[0].to).toBe(p1)

      // dryRun previews without rename
      results = media.renameService.batchRename(
        ['rn-alpha'],
        '{name}-{category}-{index}-{arch}',
        true
      )
      expect(results[0].ok).toBe(true)
      expect(results[0].to).toBe(join(dir, 'alpha-checkpoints-001-sdxl.safetensors'))
      expect(existsSync(p1)).toBe(true)

      // illegal / empty name after sanitize (pattern becomes only illegal chars)
      results = media.renameService.batchRename(['rn-alpha'], '///', true)
      expect(results[0].ok).toBe(false)
      expect(results[0].error).toBeTruthy()

      // reserved win32 name
      results = media.renameService.batchRename(['rn-alpha'], 'CON', true)
      expect(results[0].ok).toBe(false)
      expect(results[0].error).toMatch(/Reserved/i)

      // happy path rename on disk + db id rehash
      results = media.renameService.batchRename(['rn-alpha'], 'renamed-{name}', false)
      expect(results[0].ok).toBe(true)
      expect(existsSync(join(dir, 'renamed-alpha.safetensors'))).toBe(true)
      expect(existsSync(p1)).toBe(false)
      const after = listModels()
      expect(after.some((m) => m.path === join(dir, 'renamed-alpha.safetensors'))).toBe(true)

      // target exists
      const p2 = join(dir, 'beta.safetensors')
      writeFileSync(p2, 'x')
      writeFileSync(join(dir, 'gamma.safetensors'), 'x')
      upsertModel(rec({ id: 'rn-beta', name: 'beta', fileName: 'beta.safetensors', path: p2 }))
      upsertModel(
        rec({
          id: 'rn-gamma',
          name: 'gamma',
          fileName: 'gamma.safetensors',
          path: join(dir, 'gamma.safetensors')
        })
      )
      results = media.renameService.batchRename(['rn-beta'], 'gamma', false)
      expect(results[0].ok).toBe(false)
      expect(results[0].error).toMatch(/target exists/i)

      // slashes in name become underscores
      const p3 = join(dir, 'weird.safetensors')
      writeFileSync(p3, 'x')
      upsertModel(
        rec({
          id: 'rn-weird',
          name: 'a/b\\c',
          fileName: 'weird.safetensors',
          path: p3,
          architecture: 'x/y'
        })
      )
      results = media.renameService.batchRename(['rn-weird'], '{name}_{arch}', false)
      expect(results[0].ok).toBe(true)
      expect(basename(results[0].to)).toBe('a_b_c_x_y.safetensors')

      // missing architecture → unknown
      const p4 = join(dir, 'plain.safetensors')
      writeFileSync(p4, 'x')
      upsertModel(
        rec({
          id: 'rn-plain',
          name: 'plain',
          fileName: 'plain.safetensors',
          path: p4,
          architecture: undefined
        })
      )
      results = media.renameService.batchRename(['rn-plain'], '{name}-{arch}', true)
      expect(results[0].to).toBe(join(dir, 'plain-unknown.safetensors'))

      // rename failure surfaces as error
      const p5 = join(dir, 'boom.safetensors')
      writeFileSync(p5, 'x')
      upsertModel(rec({ id: 'rn-boom', name: 'boom', fileName: 'boom.safetensors', path: p5 }))
      h.renameSyncImpl = () => {
        throw new Error('EBUSY')
      }
      results = media.renameService.batchRename(['rn-boom'], 'boom2', false)
      h.renameSyncImpl = null
      expect(results[0].ok).toBe(false)
      expect(results[0].error).toMatch(/EBUSY/)

      for (const id of ['rn-alpha', 'rn-beta', 'rn-gamma', 'rn-weird', 'rn-plain', 'rn-boom'])
        deleteModel(id)
    })

    it('name longer than 120 chars is truncated by the sanitizer slice', async () => {
      const media = await freshMedia()
      const { upsertModel, deleteModel } = await import('../../src/main/services/db')
      const dir = join(ROOT, 'models', 'longname')
      mkdirSync(dir, { recursive: true })
      const p = join(dir, 'long.safetensors')
      writeFileSync(p, 'x')
      upsertModel(rec({ id: 'rn-long', name: 'long', fileName: 'long.safetensors', path: p }))
      const long = 'z'.repeat(200)
      const results = media.renameService.batchRename(['rn-long'], long, true)
      expect(results[0].ok).toBe(true)
      // 120-char sanitized base + `.safetensors`
      expect(basename(results[0].to).length).toBeLessThanOrEqual(140)
      deleteModel('rn-long')
    })
  })

  // ---------- Aria2Service ----------

  describe('Aria2Service', () => {
    it('available() reflects settings', async () => {
      const media = await freshMedia()
      const { saveSettings } = await import('../../src/main/services/db')
      saveSettings({ useAria2: false })
      expect(media.aria2Service.available()).toBe(false)
      saveSettings({ useAria2: true, aria2Path: 'aria2c' })
      expect(media.aria2Service.available()).toBe(true)
      saveSettings({ useAria2: false, aria2Path: '' })
    })

    it('download success / error / resume flag', async () => {
      const media = await freshMedia()
      const dest = join(ROOT, 'dl', 'a.bin')
      mkdirSync(dirname(dest), { recursive: true })

      h.execImpl = (
        cmd: string,
        args: string[],
        cb: (e: Error | null, o: string, s: string) => void
      ) => {
        void cmd
        expect(args).toContain('-c') // resume default
        queueMicrotask(() => cb(null, 'done', ''))
      }
      let res = await media.aria2Service.download('https://example.com/a.bin', dest)
      expect(res.ok).toBe(true)
      expect(res.log).toContain('done')

      h.execImpl = (_c, args, cb) => {
        expect(args).not.toContain('-c')
        queueMicrotask(() => cb(new Error('aria2 died'), '', 'err'))
      }
      res = await media.aria2Service.download('https://example.com/a.bin', dest, { resume: false })
      expect(res.ok).toBe(false)
      expect(res.log).toMatch(/aria2 died/)
    })

    it('abort signal stops the download', async () => {
      const media = await freshMedia()
      const dest = join(ROOT, 'dl', 'b.bin')
      mkdirSync(dirname(dest), { recursive: true })
      h.hang = true
      const ac = new AbortController()
      const p = media.aria2Service.download('https://example.com/b.bin', dest, {
        signal: ac.signal
      })
      ac.abort()
      const res = await p
      expect(res.ok).toBe(false)
      expect(res.aborted).toBe(true)
      h.hang = false
    })

    it('already-aborted signal short-circuits', async () => {
      const media = await freshMedia()
      const dest = join(ROOT, 'dl', 'c.bin')
      mkdirSync(dirname(dest), { recursive: true })
      h.hang = true
      const ac = new AbortController()
      ac.abort()
      const res = await media.aria2Service.download('https://example.com/c.bin', dest, {
        signal: ac.signal
      })
      expect(res.ok).toBe(false)
      expect(res.aborted).toBe(true)
      h.hang = false
    })
  })
})

describe('output thumbnails (ensureOutputThumb / persistOutputThumb)', () => {
  it('generates, persists and then reuses the output thumbnail', async () => {
    const { thumbnailService } = await import('../../src/main/services/media')
    const dir = join(ROOT, 'output-thumbs')
    mkdirSync(dir, { recursive: true })
    const img = join(dir, 'out.png')
    writeFileSync(img, 'fake-png')

    const first = await thumbnailService.ensureOutputThumb(img)
    expect(first).toBeTruthy()
    expect(existsSync(first!)).toBe(true)
    expect(first).toContain(join('output', ''))

    // Second call hits the cached file and re-persists it (same path).
    const second = await thumbnailService.ensureOutputThumb(img)
    expect(second).toBe(first)

    const st = statSync(img)
    const key = createHash('sha1')
      .update(`${img}:${Math.floor(st.mtimeMs)}:${st.size}`)
      .digest('hex')
      .slice(0, 16)
    expect(basename(first!)).toBe(`${key}.png`)
  })

  it('invalidates the cached thumb when the source is overwritten in place', async () => {
    const { thumbnailService } = await import('../../src/main/services/media')
    const dir = join(ROOT, 'output-thumbs')
    mkdirSync(dir, { recursive: true })
    const img = join(dir, 'overwrite.png')
    writeFileSync(img, 'first-bytes')
    const first = await thumbnailService.ensureOutputThumb(img)
    expect(first).toBeTruthy()

    // Rewrite with different bytes and bump mtime explicitly.
    writeFileSync(img, 'second-bytes-longer')
    const future = new Date(Date.now() + 5000)
    utimesSync(img, future, future)
    const second = await thumbnailService.ensureOutputThumb(img)
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(existsSync(second!)).toBe(true)
  })

  it('regenerates when the cached file for the SAME key is older than the source', async () => {
    const { thumbnailService } = await import('../../src/main/services/media')
    const { cacheDir } = await import('../../src/main/services/db')
    const dir = join(ROOT, 'output-thumbs')
    mkdirSync(dir, { recursive: true })
    const img = join(dir, 'same-key.png')
    writeFileSync(img, 'bytes')
    const st = statSync(img)
    const key = createHash('sha1')
      .update(`${img}:${Math.floor(st.mtimeMs)}:${st.size}`)
      .digest('hex')
      .slice(0, 16)
    const out = join(cacheDir(), 'thumbs', 'output', `${key}.png`)
    mkdirSync(join(cacheDir(), 'thumbs', 'output'), { recursive: true })
    writeFileSync(out, 'stale-thumb')
    const past = new Date(Date.now() - 60_000)
    utimesSync(out, past, past)

    const thumb = await thumbnailService.ensureOutputThumb(img)
    expect(thumb).toBe(out)
    // The stale bytes were replaced by the freshly encoded PNG.
    expect(readFileSync(thumb!, 'utf-8')).not.toBe('stale-thumb')
  })

  it('returns null for non-images and missing files', async () => {
    const { thumbnailService } = await import('../../src/main/services/media')
    const dir = join(ROOT, 'output-thumbs')
    mkdirSync(dir, { recursive: true })
    const txt = join(dir, 'note.txt')
    writeFileSync(txt, 'x')
    expect(await thumbnailService.ensureOutputThumb(txt)).toBeNull()
    expect(await thumbnailService.ensureOutputThumb(join(dir, 'missing.png'))).toBeNull()
  })

  it('handles undecodable and already-small images', async () => {
    const { thumbnailService } = await import('../../src/main/services/media')
    const dir = join(ROOT, 'output-thumbs')
    mkdirSync(dir, { recursive: true })
    // nativeImage reports empty → null (no resize attempted).
    const broken = join(dir, 'broken.png')
    writeFileSync(broken, 'not-a-real-png')
    expect(await thumbnailService.ensureOutputThumb(broken)).toBeNull()
    // Scale >= 1 path: image smaller than 320px is written without resize.
    const small = join(dir, 'small.png')
    writeFileSync(small, 'tiny')
    const thumb = await thumbnailService.ensureOutputThumb(small)
    expect(thumb).toBeTruthy()
    expect(existsSync(thumb!)).toBe(true)
  })

  it('generates static first-frame thumbs for gif sources', async () => {
    const { thumbnailService } = await import('../../src/main/services/media')
    const dir = join(ROOT, 'output-thumbs')
    mkdirSync(dir, { recursive: true })
    const gif = join(dir, 'anim.gif')
    writeFileSync(gif, 'gif-bytes')
    const thumb = await thumbnailService.ensureOutputThumb(gif)
    expect(thumb).toBeTruthy()
    expect(thumb!.endsWith('.png')).toBe(true)
  })

  it('prunes only thumbs older than the age threshold', async () => {
    const { pruneOldOutputThumbs } = await import('../../src/main/services/media')
    const { cacheDir } = await import('../../src/main/services/db')
    const root = join(cacheDir(), 'thumbs', 'output')
    mkdirSync(root, { recursive: true })
    const oldFile = join(root, 'old-thumb.png')
    const freshFile = join(root, 'fresh-thumb.png')
    writeFileSync(oldFile, 'x')
    writeFileSync(freshFile, 'x')
    const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    utimesSync(oldFile, past, past)

    const removed = pruneOldOutputThumbs()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(freshFile)).toBe(true)
  })

  it('clears DB thumbnail pointers only when thumb AND source are gone', async () => {
    const { pruneDeadOutputThumbRows } = await import('../../src/main/services/media')
    const { upsertOutputAsset, listOutputAssetsAll, deleteOutputAsset } =
      await import('../../src/main/services/db')
    // The DB lives in a shared tmp dir across runs — remove rows from earlier
    // runs so `cleared` stays deterministic for THIS test only.
    for (const r of listOutputAssetsAll()) {
      if (r.id.startsWith('dead-')) deleteOutputAsset(r.id)
    }
    const dir = join(ROOT, 'dead-rows')
    mkdirSync(dir, { recursive: true })
    // Row 1: both thumb and source missing → cleared.
    upsertOutputAsset({
      id: 'dead-1',
      path: join(dir, 'gone.png'),
      fileName: 'gone.png',
      type: 'image',
      size: 1,
      createdAt: 1,
      thumbnail: join(dir, 'missing-thumb.png'),
      params: {}
    })
    // Row 2: source exists, thumb missing → kept (lazy heal on next list()).
    const alive = join(dir, 'alive.png')
    writeFileSync(alive, 'x')
    upsertOutputAsset({
      id: 'dead-2',
      path: alive,
      fileName: 'alive.png',
      type: 'image',
      size: 1,
      createdAt: 1,
      thumbnail: join(dir, 'missing-thumb-2.png'),
      params: {}
    })
    // Row 3: thumb file exists → untouched.
    const okThumb = join(dir, 'ok-thumb.png')
    writeFileSync(okThumb, 'x')
    upsertOutputAsset({
      id: 'dead-3',
      path: join(dir, 'whatever.png'),
      fileName: 'whatever.png',
      type: 'image',
      size: 1,
      createdAt: 1,
      thumbnail: okThumb,
      params: {}
    })
    // Row 4: no thumbnail at all → skipped.
    upsertOutputAsset({
      id: 'dead-4',
      path: join(dir, 'no-thumb.png'),
      fileName: 'no-thumb.png',
      type: 'image',
      size: 1,
      createdAt: 1,
      params: {}
    })

    const cleared = pruneDeadOutputThumbRows()
    expect(cleared).toBe(1)
    // Idempotent: a second pass has nothing left to clear.
    expect(pruneDeadOutputThumbRows()).toBe(0)
    const rows = listOutputAssetsAll()
    expect(rows.find((r) => r.id === 'dead-1')?.thumbnail).toBeUndefined()
    expect(rows.find((r) => r.id === 'dead-2')?.thumbnail).toBeTruthy()
    expect(rows.find((r) => r.id === 'dead-3')?.thumbnail).toBe(okThumb)
    expect(rows.find((r) => r.id === 'dead-4')?.thumbnail).toBeUndefined()
  })
})
