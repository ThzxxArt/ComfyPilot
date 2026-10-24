/**
 * Runtime bootstrap — zero-prerequisite support layer.
 *
 * Downloads and manages portable toolchains under userData/runtimes/ so a clean
 * machine (no Python, no Git, no uv) can still complete the one-click installer:
 *   uv            — single-file package manager; also fetches CPython
 *   python        — portable CPython 3.12 (fallback when uv is unwanted)
 *   mingit        — portable Git (only for git-based node installs / clone mode)
 *
 * All downloads honor app proxy settings and resume partial files.
 */
import { EventEmitter } from 'events'
import {
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  readdirSync,
  chmodSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { join, dirname, resolve, basename } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { app } from 'electron'
import type {
  BootstrapStatus,
  RuntimeComponentStatus,
  RuntimeDownloadProgress,
  RuntimeKind
} from '@shared/types'
import { RUNTIME_SOURCES } from '@shared/constants'
import { loadSettings } from './db'
import { comfyChildEnv } from './childEnv'
import { isPathInside, normalizePathEverySegment } from './security'
import { assertExtractedInside, safeUnzip } from './zipSafe'

const execFileAsync = promisify(execFile)

function runtimesDir(): string {
  const dir = join(app.getPath('userData'), 'runtimes')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function downloadCacheDir(): string {
  const dir = join(runtimesDir(), 'downloads')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Pinned checksums after a trusted first download (or official SHA256SUMS). */
function checksumStorePath(): string {
  return join(runtimesDir(), 'checksums.json')
}

function loadChecksumStore(): Record<string, string> {
  try {
    if (existsSync(checksumStorePath())) {
      return JSON.parse(readFileSync(checksumStorePath(), 'utf-8')) as Record<string, string>
    }
  } catch {
    /* ignore */
  }
  return {}
}

function saveChecksumStore(store: Record<string, string>): void {
  try {
    writeFileSync(checksumStorePath(), JSON.stringify(store, null, 2), 'utf-8')
  } catch {
    /* ignore */
  }
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(filePath)
    rs.on('data', (d) => hash.update(d))
    rs.on('end', () => resolveHash(hash.digest('hex')))
    rs.on('error', reject)
  })
}

/**
 * Try to fetch an official companion checksum for a release asset.
 * Supports `<file>.sha256` / `.sha256sum` and `SHA256SUMS` listings.
 */
async function fetchOfficialSha256(url: string): Promise<string | null> {
  const candidates = [`${url}.sha256`, `${url}.sha256sum`]
  const { session } = await import('electron')
  for (const cand of candidates) {
    try {
      const res = await session.defaultSession.fetch(cand, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const text = (await res.text()).trim()
      const m = text.match(/\b([a-f0-9]{64})\b/i)
      if (m) return m[1].toLowerCase()
    } catch {
      /* try next */
    }
  }
  try {
    const sumsUrl = url.replace(/[^/]+$/, 'SHA256SUMS')
    const res = await session.defaultSession.fetch(sumsUrl, {
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      const text = await res.text()
      const file = basename(new URL(url).pathname)
      const line = text.split('\n').find((l) => l.trim().endsWith(file))
      const m = line?.match(/\b([a-f0-9]{64})\b/i)
      if (m) return m[1].toLowerCase()
    }
  } catch {
    /* ignore */
  }
  return null
}

function platformKey(): { uv: string; python: string; mingit: string | null } {
  const p = process.platform
  const arch = process.arch
  if (p === 'win32') {
    // x64 covers both; arm64 Windows can run x64 python under emulation.
    return { uv: 'uv-win-x64', python: 'python-win-x64', mingit: 'mingit-win-x64' }
  }
  if (p === 'darwin') {
    return {
      uv: arch === 'arm64' ? 'uv-darwin-arm64' : 'uv-darwin-x64',
      python: arch === 'arm64' ? 'python-darwin-arm64' : 'python-darwin-x64',
      mingit: null // use system git on macOS
    }
  }
  if (arch === 'arm64') {
    return { uv: 'uv-linux-arm64', python: 'python-linux-arm64', mingit: null }
  }
  return { uv: 'uv-linux-x64', python: 'python-linux-x64', mingit: null }
}

function exeName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

async function safeVersion(
  cmd: string,
  args: string[] = ['--version']
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: comfyChildEnv(loadSettings())
    })
    return stdout.trim().split('\n')[0] || undefined
  } catch {
    return undefined
  }
}

/** Find an executable on PATH (or already in runtimes/). */
async function which(cmd: string): Promise<string | null> {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await execFileAsync(probe, [cmd], {
      timeout: 5000,
      windowsHide: true,
      env: comfyChildEnv(loadSettings())
    })
    const first = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
    return first || null
  } catch {
    return null
  }
}

function runtimeBinName(kind: RuntimeKind): string {
  if (kind === 'mingit') return 'git'
  if (kind === 'aria2') return 'aria2c'
  return kind
}

/** Locate an executable under userData/runtimes (depth-limited). Exported for tests + instance.ts. */
export function findInRuntimes(name: string): string | null {
  const root = runtimesDir()
  const wanted = exeName(name)
  const altNames =
    name === 'python'
      ? [wanted, process.platform === 'win32' ? 'python.exe' : 'python3', 'python3', 'python3.12']
      : [wanted]
  const seen = new Set<string>()
  // Depth-limited walk — install_only archives nest a top-level `python/` dir,
  // MinGit nests `cmd/git.exe` (sometimes under `mingit64/`).
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 3) return null
    let key = dir
    try {
      key = resolve(dir)
    } catch {
      /* keep raw */
    }
    if (seen.has(key)) return null
    seen.add(key)
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }
    for (const alt of altNames) {
      const hit = join(dir, alt)
      try {
        // Must be a real file — `python3.12` can be a directory name (lib/python3.12).
        const st = statSync(hit)
        if (st.isFile() || st.isSymbolicLink()) return hit
      } catch {
        /* missing */
      }
    }
    for (const entry of entries) {
      const p = join(dir, entry)
      try {
        if (!statSync(p).isDirectory()) continue
      } catch {
        continue
      }
      const found = walk(p, depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(root, 0)
}

export class BootstrapService extends EventEmitter {
  private installing = new Map<RuntimeKind, Promise<RuntimeComponentStatus>>()
  /** Abort in-flight downloads/extracts when the parent installer cancels. */
  private aborts = new Set<AbortController>()
  /**
   * Bumped by cancelAll(). An in-flight ensure() compares its start value with
   * the current one: only the run that was live at cancel time is aborted, a
   * later ensure() (new install run) starts clean (0.1.17 WP1).
   */
  private cancelEpoch = 0

  private emitProgress(p: RuntimeDownloadProgress): void {
    this.emit('progress', p)
  }

  /** Abort all in-flight runtime downloads (wired to installer.cancel). */
  cancelAll(): void {
    this.cancelEpoch += 1
    for (const a of this.aborts) {
      try {
        a.abort()
      } catch {
        /* ignore */
      }
    }
    this.aborts.clear()
  }

  /**
   * Throw before starting any further kind once the parent cancelled. Without
   * this, `ensure` caught the abort as a per-kind failure and happily began the
   * NEXT runtime download — the cancel looked ignored for minutes (0.1.17 WP1).
   */
  private throwIfAborted(signal: AbortSignal | undefined, epochAtStart: number): void {
    if (this.cancelEpoch !== epochAtStart || signal?.aborted) {
      const err = new Error('Runtime bootstrap aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  /** Snapshot of every runtime: system-found or downloaded. */
  async status(): Promise<BootstrapStatus> {
    const components: RuntimeComponentStatus[] = []

    for (const kind of ['uv', 'python', 'mingit', 'aria2'] as RuntimeKind[]) {
      components.push(await this.probeKind(kind))
    }

    const python = this.resolveBestPython(components)
    return {
      runtimesDir: runtimesDir(),
      components,
      pythonPath: python.path,
      pythonOrigin: python.origin,
      zipInstallReady: true // zip fetch needs no Git — always ready
    }
  }

  private async probeKind(kind: RuntimeKind): Promise<RuntimeComponentStatus> {
    // 1) already inside runtimes/
    const local = findInRuntimes(runtimeBinName(kind))
    if (local) {
      const cmd = kind === 'mingit' ? join(dirname(local), 'git.exe') : local
      const real = existsSync(cmd) ? cmd : local
      return {
        kind,
        path: real,
        installed: true,
        version: await safeVersion(real),
        origin: 'runtimes'
      }
    }
    // 2) system PATH
    const sysName =
      kind === 'mingit' ? 'git' : kind === 'python' ? 'python' : kind === 'uv' ? 'uv' : 'aria2c'
    const sys = await which(sysName)
    if (sys) {
      return {
        kind,
        path: sys,
        installed: true,
        version: await safeVersion(sys),
        origin: 'system'
      }
    }
    // 3) common Windows python installs (so we don't needlessly download)
    if (kind === 'python') {
      for (const p of [
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
        join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe'
      ]) {
        if (p && existsSync(p)) {
          return { kind, path: p, installed: true, version: await safeVersion(p), origin: 'system' }
        }
      }
    }
    return {
      kind,
      path: '',
      installed: false,
      origin: 'missing',
      version: undefined
    }
  }

  private resolveBestPython(components: RuntimeComponentStatus[]): {
    path: string
    origin: RuntimeComponentStatus['origin']
  } {
    const py = components.find((c) => c.kind === 'python' && c.installed)
    if (py?.path) return { path: py.path, origin: py.origin }
    return { path: 'python', origin: 'missing' }
  }

  /**
   * Ensure runtimes exist. When downloadIfMissing is true, fetches anything
   * missing (uv first — it can then provide Python). Returns updated status.
   */
  async ensure(opts?: {
    kinds?: RuntimeKind[]
    downloadIfMissing?: boolean
    signal?: AbortSignal
  }): Promise<BootstrapStatus> {
    const kinds = opts?.kinds || ['uv', 'python']
    // 0.1.17 (WP1): a cancellation only ends the ensure() that was live when it
    // happened; a later install run gets a fresh epoch and proceeds normally.
    const epochAtStart = this.cancelEpoch
    if (opts?.downloadIfMissing !== false) {
      this.throwIfAborted(opts?.signal, epochAtStart)
      for (const kind of kinds) {
        this.throwIfAborted(opts?.signal, epochAtStart)
        const st = await this.probeKind(kind)
        // A cancel can land during the probe; without this the download would
        // start after cancelAll() and its fetch would never be aborted.
        this.throwIfAborted(opts?.signal, epochAtStart)
        if (!st.installed) {
          try {
            await this.download(kind, epochAtStart)
          } catch (err) {
            // A cancel is not a "this runtime failed" event — it ends the whole
            // ensure() so the caller can report a real cancellation.
            if ((err as Error)?.name === 'AbortError' || this.cancelEpoch !== epochAtStart) {
              throw err
            }
            // uv failure is fatal only if python is also missing — record and continue.
            this.emitProgress({
              kind,
              receivedBytes: 0,
              totalBytes: 0,
              speedBps: 0,
              phase: 'error',
              message: err instanceof Error ? err.message : String(err)
            })
          }
        }
      }
      this.throwIfAborted(opts?.signal, epochAtStart)
    }
    return this.status()
  }

  /**
   * Download + extract a runtime into userData/runtimes/<kind>/.
   * Concurrent calls for the same kind share one promise.
   */
  async download(kind: RuntimeKind, epochAtStart?: number): Promise<RuntimeComponentStatus> {
    const existing = this.installing.get(kind)
    if (existing) return existing
    const p = this.downloadInner(kind, epochAtStart).finally(() => this.installing.delete(kind))
    this.installing.set(kind, p)
    return p
  }

  private runtimeSource(kind: RuntimeKind): {
    url: string
    sizeHint: number
    sha256?: string
  } {
    const keys = platformKey()
    const id =
      kind === 'uv'
        ? keys.uv
        : kind === 'python'
          ? keys.python
          : kind === 'mingit'
            ? keys.mingit
            : null
    if (!id || !RUNTIME_SOURCES[id]) {
      throw new Error(`No runtime source for ${kind} on ${process.platform}/${process.arch}`)
    }
    return RUNTIME_SOURCES[id]
  }

  private applyGithubMirror(url: string): string {
    try {
      const endpoint = String(loadSettings().githubEndpoint || '').trim()
      if (!endpoint) return url
      if (!/github\.com/i.test(url)) return url
      return endpoint.replace(/\/+$/, '') + '/' + url
    } catch {
      return url
    }
  }

  private async downloadInner(
    kind: RuntimeKind,
    epochAtStart?: number
  ): Promise<RuntimeComponentStatus> {
    const src = this.runtimeSource(kind)
    const url = this.applyGithubMirror(src.url)
    const fileName = basename(new URL(url).pathname) || `${kind}.bin`
    const cachePath = join(downloadCacheDir(), fileName)
    const destRoot = join(runtimesDir(), normalizePathEverySegment(kind))
    if (!existsSync(destRoot)) mkdirSync(destRoot, { recursive: true })

    this.emitProgress({
      kind,
      receivedBytes: 0,
      totalBytes: src.sizeHint,
      speedBps: 0,
      phase: 'download',
      message: `Downloading ${kind}…`
    })

    await this.downloadFile(url, cachePath, kind, src.sizeHint, epochAtStart)

    // Integrity: build-time pin → official checksum → a pin from a previous
    // VERIFIED download. 0.1.18: with none of them, refuse and delete the
    // download instead of silently pinning whatever arrived first. The
    // build-time pin is what keeps Windows installs working behind a mirror
    // (MinGit ships no sidecar at all).
    try {
      const actual = await sha256File(cachePath)
      const store = loadChecksumStore()
      const key = url
      // A mirror may not proxy the `.sha256` sidecar; retry the canonical URL.
      const official =
        (await fetchOfficialSha256(url)) ||
        (url !== src.url ? await fetchOfficialSha256(src.url) : null)
      const pinned = store[key]
      const declared = src.sha256 ? String(src.sha256).toLowerCase() : ''
      const expected = declared || official || pinned
      if (expected && expected.toLowerCase() !== actual.toLowerCase()) {
        rmSync(cachePath, { force: true })
        throw new Error(
          `Runtime checksum mismatch for ${kind} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`
        )
      }
      if (!declared && !official && !pinned) {
        const allow = loadSettings().allowUnverifiedRuntime === true
        if (!allow) {
          rmSync(cachePath, { force: true })
          const e = new Error(
            `No published checksum for ${kind} (${src.url}). Refusing to install an unverified runtime — ` +
              `enable "allow unverified runtime" in Settings → Security if you accept the risk.`
          ) as Error & { code?: string }
          e.code = 'RUNTIME_UNVERIFIED'
          throw e
        }
        // Explicit opt-in: record the hash the user accepted.
        store[key] = actual
        saveChecksumStore(store)
      } else if (!pinned) {
        // Declared/official checksum matched — this is a trustworthy pin.
        store[key] = actual
        saveChecksumStore(store)
      }
    } catch (err) {
      const coded = err as Error & { code?: string }
      if (
        coded.code === 'RUNTIME_UNVERIFIED' ||
        (err instanceof Error && err.message.includes('checksum mismatch'))
      ) {
        throw err
      }
      // A hashing failure is still fatal: without a digest there is no
      // integrity evidence at all. Length was only a transport check.
      rmSync(cachePath, { force: true })
      throw new Error(
        `Runtime integrity check failed for ${kind}: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    this.emitProgress({
      kind,
      receivedBytes: src.sizeHint,
      totalBytes: src.sizeHint,
      speedBps: 0,
      phase: 'extract',
      message: `Extracting ${kind}…`
    })

    await this.extractArchive(cachePath, destRoot)

    // uv/python single-file convenience: chmod +x on unix
    if (process.platform !== 'win32') {
      try {
        const hit = findInRuntimes(runtimeBinName(kind))
        if (hit) chmodSync(hit, 0o755)
      } catch {
        /* ignore */
      }
    }

    const st = await this.probeKind(kind)
    this.emitProgress({
      kind,
      receivedBytes: src.sizeHint,
      totalBytes: src.sizeHint,
      speedBps: 0,
      phase: 'done',
      message: `${kind} ready`
    })
    return st
  }

  /** Resumable HTTP download with speed/progress events. */
  private async downloadFile(
    url: string,
    dest: string,
    kind: RuntimeKind,
    sizeHint: number,
    epochAtStart?: number
  ): Promise<void> {
    // Electron session fetch honors the app proxy (same path as model.ts downloads).
    const { session } = await import('electron')
    const headers: Record<string, string> = { 'User-Agent': 'ComfyPilot/0.1' }

    // Resume from the partial file THIS function writes (`${dest}.part`).
    // The old code read `dest`, but bytes are only ever written to `.part`
    // before the final rename — so a retry always restarted at 0 and the
    // orphaned `.part` was never resumed nor cleaned (0.1.13).
    const tmp = `${dest}.part`
    let startByte = 0
    if (existsSync(tmp)) {
      try {
        startByte = statSync(tmp).size
      } catch {
        startByte = 0
      }
    }
    if (startByte > 0) headers.Range = `bytes=${startByte}-`

    const ac = new AbortController()
    // 0.1.17 (review fix): cancelAll() may have run while we were awaiting the
    // electron module — that epoch bump was invisible here, so the fetch started
    // un-aborted and never settled (an install cancel could hang forever).
    if (epochAtStart !== undefined && this.cancelEpoch !== epochAtStart) {
      ac.abort()
    }
    this.aborts.add(ac)
    const timeout = AbortSignal.timeout(15 * 60 * 1000)
    const signal = AbortSignal.any([ac.signal, timeout])
    try {
      const res = await session.defaultSession.fetch(url, {
        headers,
        signal
      })
      if (!res.ok && res.status !== 206) {
        // Range-overrun means the file we resumed from already covers the
        // whole resource. Check the `.part` (what we actually resumed from)
        // or a previously completed `dest`; validate size + pinned checksum
        // before accepting it — a half file is not proof of completeness.
        const candidate =
          res.status === 416
            ? existsSync(tmp) && statSync(tmp).size > 0
              ? tmp
              : existsSync(dest) && statSync(dest).size > 0
                ? dest
                : null
            : null
        if (candidate) {
          const size = statSync(candidate).size
          const store = loadChecksumStore()
          const pinned = store[url]
          if (sizeHint > 0 && size < sizeHint * 0.9) {
            rmSync(candidate, { force: true })
            throw new Error('Cached runtime archive looks truncated — re-downloading')
          }
          if (pinned) {
            const actual = await sha256File(candidate)
            if (actual.toLowerCase() !== pinned.toLowerCase()) {
              rmSync(candidate, { force: true })
              throw new Error('Cached runtime archive failed checksum — re-downloading')
            }
          }
          if (candidate === tmp) renameSync(tmp, dest)
          return
        }
        throw new Error(`Runtime download failed: HTTP ${res.status} for ${url}`)
      }

      const isAppend = res.status === 206 && startByte > 0
      const totalHeader = Number(res.headers.get('content-length') || 0)
      const totalBytes = isAppend ? startByte + totalHeader : totalHeader || sizeHint

      // A 200 answer to a ranged request cannot be appended to a partial
      // file (it starts at 0) — restart the partial cleanly.
      const fileStream = createWriteStream(tmp, { flags: isAppend ? 'a' : 'w' })
      // Disk-full / abort must not raise an unhandled 'error' event.
      let streamError: Error | null = null
      fileStream.on('error', (e) => {
        streamError = e
      })
      const reader = res.body?.getReader()
      if (!reader) {
        fileStream.destroy()
        throw new Error('Runtime download: empty body')
      }

      let received = isAppend ? startByte : 0
      let lastTick = Date.now()
      let lastBytes = received

      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (streamError) throw streamError
          if (value) {
            fileStream.write(Buffer.from(value))
            received += value.byteLength
            const now = Date.now()
            if (now - lastTick >= 500) {
              const speedBps = ((received - lastBytes) / (now - lastTick)) * 1000
              lastTick = now
              lastBytes = received
              this.emitProgress({
                kind,
                receivedBytes: received,
                totalBytes,
                speedBps,
                phase: 'download'
              })
            }
          }
        }
      } catch (e) {
        // Aborted/cancelled or write failure: release the fd instead of
        // leaking it (on Windows the locked .part then breaks cleanup/retry).
        try {
          fileStream.destroy()
        } catch {
          /* ignore */
        }
        throw e
      }
      if (streamError) throw streamError
      await new Promise<void>((resolveDone, reject) => {
        fileStream.end((err?: Error | null) => (err ? reject(err) : resolveDone()))
      })

      // Length gate before promoting .part → dest. A dropped connection must not
      // become a "complete" archive (and must not poison resume with 416).
      const finalSize = existsSync(tmp) ? statSync(tmp).size : 0
      if (totalBytes > 0 && finalSize !== totalBytes) {
        rmSync(tmp, { force: true })
        throw new Error(`Runtime download truncated: ${finalSize} of ${totalBytes} bytes`)
      }

      if (existsSync(tmp)) renameSync(tmp, dest)
    } finally {
      this.aborts.delete(ac)
    }
  }

  /**
   * Extract zip/tar.gz into destDir.
   *
   * 0.1.17 (WP8): zip goes through the shared `safeUnzip` (entry validation,
   * extraction, containment walk). This path used to call Expand-Archive
   * directly, skipping every check the other three extract sites already had.
   * Tarballs get the same post-extract walk (`tar` has no entry pre-check).
   */
  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
    const lower = archivePath.toLowerCase()
    const env = comfyChildEnv(loadSettings())
    if (lower.endsWith('.zip')) {
      await safeUnzip(archivePath, destDir)
      return
    }
    // tar.gz / tgz
    // 0.1.17 (review fix): list the members FIRST. `tar` has no entry
    // validation, and a post-extract walk cannot see a member that was written
    // outside destDir (e.g. `../evil`) — the file is already gone from destDir.
    const listing = await execFileAsync('tar', ['-tzf', archivePath], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env
    })
    for (const raw of String(listing.stdout).split('\n')) {
      const member = raw.trim()
      if (!member) continue
      const normalized = member.replace(/\\/g, '/')
      if (
        normalized.startsWith('/') ||
        /^[a-zA-Z]:/.test(normalized) ||
        normalized.split('/').includes('..')
      ) {
        throw new Error(`Unsafe path in archive: ${member}`)
      }
    }
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], {
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env
    })
    assertExtractedInside(destDir)
  }

  /** Wipe a half-extracted runtime directory (install rollback). */
  cleanupRuntime(kind: RuntimeKind): void {
    const destRoot = join(runtimesDir(), normalizePathEverySegment(kind))
    if (isPathInside(destRoot, runtimesDir())) {
      try {
        rmSync(destRoot, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export const bootstrapService = new BootstrapService()

export { runtimesDir }
export { resolve as resolvePath }
