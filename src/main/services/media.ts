import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'fs'
import { join, basename, dirname, extname, resolve } from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import {
  cacheDir,
  loadSettings,
  listModels,
  upsertModel,
  loadInstanceConfigs,
  deleteModel as dbDeleteModel,
  workflowLibraryDir,
  listOutputAssetsAll,
  mergeUpsertOutputAsset,
  clearOutputAssetThumbnails
} from './db'
import { resolveOutputDir } from './p1p2'
import { assertSafeRelativeFilename, isSafeExternalUrl, isPathInside } from './security'
import { isMediaServable } from '@shared/mediaTypes'
import type { ModelRecord } from '@shared/types'

/**
 * Thumbnail pipeline (PLAN: 缩略图存 userData/cache)
 * Priority: sidecar preview.png → civitai meta image → generated placeholder card.
 */
export class ThumbnailService {
  cacheRoot(): string {
    return join(cacheDir(), 'thumbs')
  }

  private ensure(): string {
    const dir = this.cacheRoot()
    mkdirSync(dir, { recursive: true })
    return dir
  }

  thumbPathFor(id: string): string {
    return join(this.ensure(), `${id}.png`)
  }

  /** Generate or reuse thumbnail for a model record. */
  async ensureModelThumb(rec: ModelRecord): Promise<string | null> {
    const out = this.thumbPathFor(rec.id)
    if (existsSync(out)) return out

    // 1) sidecar: foo.preview.png / foo.png next to model
    const base = rec.path.replace(/\.[^.]+$/, '')
    for (const cand of [`${base}.preview.png`, `${base}.png`, `${base}.jpg`, `${base}.jpeg`]) {
      if (existsSync(cand)) {
        try {
          const buf = readFileSync(cand)
          // Preserve real image bytes; only the cache filename is hashed by id.
          writeFileSync(out, buf)
          this.mark(rec, out)
          return out
        } catch {
          /* fallthrough */
        }
      }
    }

    // 2) Civitai metadata thumbnail
    if (rec.source === 'civitai' || rec.metadata?.civitai) {
      const meta = rec.metadata?.civitai as { images?: Array<{ url?: string }> } | undefined
      const url = meta?.images?.[0]?.url
      if (url) {
        try {
          const { proxyFetch } = await import('./proxy')
          const res = await proxyFetch(url, { timeoutMs: 15000 })
          if (res.ok) {
            writeFileSync(out, Buffer.from(await res.arrayBuffer()))
            this.mark(rec, out)
            return out
          }
        } catch {
          /* fallthrough */
        }
      }
    }

    // 3) generated SVG placeholder (no external deps)
    try {
      const svg = this.placeholderSvg(rec)
      const svgPath = join(this.ensure(), `${rec.id}.svg`)
      writeFileSync(svgPath, svg)
      // also store as .png path pointer via svg content in png-named file is wrong;
      // keep svg and point thumbnail field to svg
      this.mark(rec, svgPath)
      return svgPath
    } catch {
      return null
    }
  }

  private mark(rec: ModelRecord, thumbPath: string): void {
    const next: ModelRecord = { ...rec, thumbnail: thumbPath }
    upsertModel(next)
  }

  private placeholderSvg(rec: ModelRecord): string {
    // XML-escape interpolated text (0.1.11): a model name containing & or <
    // used to corrupt the SVG document into a broken image.
    const escapeXml = (s: string): string =>
      String(s).replace(
        /[<>&'"]/g,
        (c) =>
          ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string
      )
    const label = escapeXml(rec.name.slice(0, 18))
    const cat = escapeXml(rec.category)
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#4F6EF7"/>
      <stop offset="50%" stop-color="#7C5CFC"/>
      <stop offset="100%" stop-color="#22D3EE"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="24" fill="url(#g)"/>
  <text x="28" y="48" fill="rgba(255,255,255,0.9)" font-size="18" font-family="Inter,sans-serif">${cat}</text>
  <text x="28" y="140" fill="#ffffff" font-size="22" font-weight="700" font-family="Inter,sans-serif">${label}</text>
  <text x="28" y="210" fill="rgba(255,255,255,0.75)" font-size="12" font-family="Inter,sans-serif">ComfyPilot</text>
</svg>`
  }

  /** Batch generate thumbnails for all scanned models. */
  async ensureAll(): Promise<number> {
    this.ensure()
    let n = 0
    for (const rec of listModels()) {
      if (rec.thumbnail && existsSync(rec.thumbnail)) continue
      const t = await this.ensureModelThumb(rec)
      if (t) n += 1
    }
    return n
  }

  // ---------- Output asset thumbnails (产物库缩略图管线) ----------

  outputThumbRoot(): string {
    return join(this.ensure(), 'output')
  }

  /**
   * Generate a downscaled thumbnail for an output image so the grid does not
   * load full-size PNGs. Returns the thumb path, or null when not applicable.
   * Persists the result on the asset row so later list() calls skip decoding.
   */
  async ensureOutputThumb(assetPath: string): Promise<string | null> {
    try {
      const ext = extname(assetPath).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'].includes(ext)) return null
      if (!existsSync(assetPath)) return null
      const root = this.outputThumbRoot()
      mkdirSync(root, { recursive: true })
      // Key includes mtime + size: an in-place overwrite of the source image
      // must produce a new thumbnail instead of serving a stale one forever.
      const st = statSync(assetPath)
      const key = createHash('sha1')
        .update(`${assetPath}:${Math.floor(st.mtimeMs)}:${st.size}`)
        .digest('hex')
        .slice(0, 16)
      const out = join(root, `${key}.png`)
      if (existsSync(out)) {
        // Freshness guard for the same-ms/same-size corner: if the cached
        // thumb is older than the source, regenerate instead of serving stale.
        let fresh = true
        try {
          fresh = statSync(out).mtimeMs >= st.mtimeMs
        } catch {
          fresh = false
        }
        if (fresh) {
          this.persistOutputThumb(assetPath, out)
          return out
        }
      }
      // Electron nativeImage can decode + resize without external deps.
      const { nativeImage } = await import('electron')
      const img = nativeImage.createFromPath(assetPath)
      if (img.isEmpty()) return null
      const size = img.getSize()
      const maxDim = 320
      const scale = Math.min(1, maxDim / Math.max(size.width || 1, size.height || 1))
      const resized =
        scale < 1 ? img.resize({ width: Math.max(1, Math.round(size.width * scale)) }) : img
      writeFileSync(out, resized.toPNG())
      this.persistOutputThumb(assetPath, out)
      return out
    } catch {
      return null
    }
  }

  /** Write the generated thumb back onto the asset row (best-effort). */
  private persistOutputThumb(assetPath: string, thumbPath: string): void {
    try {
      const row = listOutputAssetsAll().find((x) => x.path === assetPath)
      if (!row || row.thumbnail === thumbPath) return
      mergeUpsertOutputAsset({ ...row, thumbnail: thumbPath })
    } catch {
      /* index write is best-effort */
    }
  }
}

export const thumbnailService = new ThumbnailService()

// ---------- Controlled local media URLs (for <img> in the renderer) ----------
// The renderer cannot load arbitrary file:// paths (and must not). Thumbs and
// output previews are served through `comfy-pilot-media:` with an explicit
// allow-list of roots.

// 0.1.14: servability decided by the shared media catalogue (web images +
// videos + audio; raw images and 3D files stay out — OS default app opens them).

function mediaThumbsRoot(): string {
  return join(cacheDir(), 'thumbs')
}

function mediaOutputRoots(): string[] {
  const roots: string[] = []
  try {
    try {
      roots.push(workflowLibraryDir())
    } catch {
      /* ignore */
    }
    for (const c of loadInstanceConfigs()) {
      if (c.path) {
        // Honor `--output-directory` exactly like the scanner/handler do.
        roots.push(resolveOutputDir(c))
        roots.push(join(c.path, 'user', 'default', 'workflows'))
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(roots.filter(Boolean))]
}

/** Convert an absolute local media path into a safe `comfy-pilot-media:` URL. */
export function toMediaUrl(absPath: string): string | null {
  try {
    if (!absPath || !isMediaServable(absPath)) return null
    // Normalize first — lexical slice on a path containing `.`/`..` breaks rel.
    const resolved = resolve(absPath)
    const thumbs = mediaThumbsRoot()
    if (isPathInside(resolved, thumbs)) {
      // Keep the sub-path (thumbs/output/<key>.png): the resolver mirrors it.
      // A flattened URL here is what caused every output thumbnail to 403.
      const rel = resolved.slice(resolve(thumbs).length).replace(/^[\\/]+/, '')
      return `comfy-pilot-media:thumbs/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`
    }
    for (const root of mediaOutputRoots()) {
      if (root && isPathInside(resolved, root)) {
        const rel = resolved.slice(resolve(root).length).replace(/^[\\/]+/, '')
        return `comfy-pilot-media:output/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`
      }
    }
    return null
  } catch {
    return null
  }
}

/** Inverse of toMediaUrl — returns an absolute path only for allow-listed roots. */
export function resolveMediaUrlToPath(url: string): string | null {
  try {
    const raw = String(url || '').replace(/^comfy-pilot-media:/, '')
    const clean = raw.replace(/^\/+/, '')
    if (clean.startsWith('thumbs/')) {
      const rel = mediaRelativePath(clean.slice('thumbs/'.length))
      if (!rel || !isMediaServable(rel)) return null
      const root = mediaThumbsRoot()
      const full = join(root, rel)
      if (!existsSync(full) || !isPathInside(full, root)) return null
      return full
    }
    if (clean.startsWith('output/')) {
      const rel = mediaRelativePath(clean.slice('output/'.length))
      if (!rel || !isMediaServable(rel)) return null
      for (const root of mediaOutputRoots()) {
        const full = join(root, rel)
        if (existsSync(full) && isPathInside(full, root)) return full
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

/** Decode a URL-encoded relative path, refusing traversal and empty segments. */
function mediaRelativePath(relRaw: string): string | null {
  const segments = relRaw
    .split('/')
    .map((p) => decodeURIComponent(p))
    .filter((p) => p && p !== '..' && p !== '.')
  if (!segments.length) return null
  // join() with path segments — never hardcode '\\' (breaks POSIX nested paths).
  // No substring `..` check: a name like `my..image.png` is legitimate and the
  // parent-hop segments were already filtered above.
  return join(...segments)
}

/** Map a record's thumbnail field (fs path or already a media URL) to a display URL. */
export function thumbnailDisplayUrl(thumb?: string): string | null {
  if (!thumb) return null
  if (thumb.startsWith('comfy-pilot-media:')) return thumb
  return toMediaUrl(thumb)
}

/**
 * Clear DB thumbnail pointers whose thumb AND source are both gone (deleted
 * outputs). Rows whose source still exists are healed lazily by output.list,
 * which regenerates and persists a fresh thumbnail on demand.
 */
export function pruneDeadOutputThumbRows(): number {
  let cleared = 0
  try {
    // 0.1.17 (WP7): collect first, then clear in a single index write.
    const dead: string[] = []
    for (const row of listOutputAssetsAll()) {
      if (!row.thumbnail) continue
      if (existsSync(row.thumbnail)) continue
      if (row.path && existsSync(row.path)) continue
      dead.push(row.id)
    }
    if (dead.length) cleared = clearOutputAssetThumbnails(dead)
  } catch {
    /* best effort */
  }
  return cleared
}

/**
 * Delete output thumbnails older than `maxAgeMs`. Thumbs are pure cache and
 * regenerate on demand, so this only bounds disk growth from deleted outputs.
 */
export function pruneOldOutputThumbs(maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
  let removed = 0
  try {
    const root = join(cacheDir(), 'thumbs', 'output')
    if (!existsSync(root)) return 0
    const cutoff = Date.now() - maxAgeMs
    for (const name of readdirSync(root)) {
      const full = join(root, name)
      try {
        if (statSync(full).isFile() && statSync(full).mtimeMs < cutoff) {
          unlinkSync(full)
          removed += 1
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  } catch {
    /* best effort */
  }
  return removed
}

/** Batch rename models (PLAN: 批量改名). */
export class RenameService {
  /**
   * pattern supports {name} {category} {index} {arch}
   * dryRun previews without touching disk.
   */
  batchRename(
    ids: string[],
    pattern: string,
    dryRun = false
  ): Array<{ from: string; to: string; ok: boolean; error?: string }> {
    const results: Array<{ from: string; to: string; ok: boolean; error?: string }> = []
    const models = listModels()
    let index = 1
    for (const id of ids) {
      const rec = models.find((m) => m.id === id)
      if (!rec) {
        results.push({ from: id, to: '', ok: false, error: 'not found' })
        continue
      }
      const newName = pattern
        .replace(/\{name\}/g, rec.name.replace(/[\\/]/g, '_'))
        .replace(/\{category\}/g, rec.category)
        .replace(/\{index\}/g, String(index).padStart(3, '0'))
        .replace(/\{arch\}/g, (rec.architecture || 'unknown').replace(/[\\/]/g, '_'))
      // Prevent path escape via pattern content + Win32 reserved names
      let safeBase: string
      try {
        safeBase = assertSafeRelativeFilename(
          basename(newName.replace(/[\\/]/g, '_')).slice(0, 120)
        )
      } catch (e) {
        results.push({
          from: rec.path,
          to: '',
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        })
        index += 1
        continue
      }
      const ext = extname(rec.fileName)
      const dest = join(dirname(rec.path), `${safeBase}${ext}`)
      index += 1
      if (dest === rec.path) {
        results.push({ from: rec.path, to: dest, ok: true })
        continue
      }
      if (dryRun) {
        results.push({ from: rec.path, to: dest, ok: true })
        continue
      }
      try {
        if (existsSync(dest)) throw new Error('target exists')
        renameSync(rec.path, dest)
        const next: ModelRecord = {
          ...rec,
          name: safeBase,
          fileName: basename(dest),
          path: dest
        }
        dbDeleteModel(rec.id)
        upsertModel({ ...next, id: createHash('sha1').update(dest).digest('hex').slice(0, 16) })
        results.push({ from: rec.path, to: dest, ok: true })
      } catch (e) {
        results.push({
          from: rec.path,
          to: dest,
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
    return results
  }
}

export const renameService = new RenameService()

/** Optional aria2 downloader (PLAN: aria2 可选). */
export class Aria2Service {
  available(): boolean {
    const settings = loadSettings()
    const bin = settings.aria2Path || 'aria2c'
    return Boolean(bin) && settings.useAria2
  }

  async download(
    url: string,
    destPath: string,
    opts?: { resume?: boolean; signal?: AbortSignal }
  ): Promise<{ ok: boolean; log: string; aborted?: boolean }> {
    if (!isSafeExternalUrl(url)) {
      return { ok: false, log: `Blocked URL scheme: ${url.slice(0, 40)}` }
    }
    const settings = loadSettings()
    const bin = settings.aria2Path || 'aria2c'
    const { comfyChildEnv } = await import('./childEnv')
    const args = ['-x', '8', '-s', '8', '-d', dirname(destPath), '-o', basename(destPath)]
    // -c continue / resume partial
    if (opts?.resume !== false) args.push('-c')
    args.push(url)
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: { ok: boolean; log: string; aborted?: boolean }): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const child = execFile(
        bin,
        args,
        {
          timeout: 30 * 60 * 1000,
          maxBuffer: 20 * 1024 * 1024,
          env: comfyChildEnv(settings)
        },
        (e, stdout, stderr) => {
          const log = (stdout || '') + (stderr || '')
          if (opts?.signal?.aborted) {
            finish({ ok: false, log: log || 'aborted', aborted: true })
            return
          }
          if (e) finish({ ok: false, log: e instanceof Error ? e.message : String(e) })
          else finish({ ok: true, log })
        }
      )
      const onAbort = (): void => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
        finish({ ok: false, log: 'aborted', aborted: true })
      }
      if (opts?.signal) {
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

export const aria2Service = new Aria2Service()
