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
import { proxyEnv } from './proxy'
import { isPathInside, normalizePathEverySegment } from './security'

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

async function safeVersion(cmd: string, args: string[] = ['--version']): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: proxyEnv(loadSettings().proxy)
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
      env: proxyEnv(loadSettings().proxy)
    })
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
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

  private emitProgress(p: RuntimeDownloadProgress): void {
    this.emit('progress', p)
  }

  /** Abort all in-flight runtime downloads (wired to installer.cancel). */
  cancelAll(): void {
    for (const a of this.aborts) {
      try {
        a.abort()
      } catch {
        /* ignore */
      }
    }
    this.aborts.clear()
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
    const sysName = kind === 'mingit' ? 'git' : kind === 'python' ? 'python' : kind === 'uv' ? 'uv' : 'aria2c'
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
  }): Promise<BootstrapStatus> {
    const kinds = opts?.kinds || ['uv', 'python']
    if (opts?.downloadIfMissing !== false) {
      for (const kind of kinds) {
        const st = await this.probeKind(kind)
        if (!st.installed) {
          try {
            await this.download(kind)
          } catch (err) {
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
    }
    return this.status()
  }

  /**
   * Download + extract a runtime into userData/runtimes/<kind>/.
   * Concurrent calls for the same kind share one promise.
   */
  async download(kind: RuntimeKind): Promise<RuntimeComponentStatus> {
    const existing = this.installing.get(kind)
    if (existing) return existing
    const p = this.downloadInner(kind).finally(() => this.installing.delete(kind))
    this.installing.set(kind, p)
    return p
  }

  private runtimeSource(kind: RuntimeKind): { url: string; sizeHint: number } {
    const keys = platformKey()
    const id =
      kind === 'uv' ? keys.uv : kind === 'python' ? keys.python : kind === 'mingit' ? keys.mingit : null
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

  private async downloadInner(kind: RuntimeKind): Promise<RuntimeComponentStatus> {
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

    await this.downloadFile(url, cachePath, kind, src.sizeHint)

    // Integrity: prefer official checksum, else pin-on-first-use.
    try {
      const actual = await sha256File(cachePath)
      const store = loadChecksumStore()
      const key = url
      const official = await fetchOfficialSha256(url)
      const pinned = store[key]
      const expected = official || pinned
      if (expected && expected.toLowerCase() !== actual.toLowerCase()) {
        rmSync(cachePath, { force: true })
        throw new Error(`Runtime checksum mismatch for ${kind} (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
      }
      if (!pinned) {
        store[key] = actual
        saveChecksumStore(store)
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('checksum mismatch')) throw err
      // Non-fatal if hashing itself failed — length was already checked in downloadFile.
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
    sizeHint: number
  ): Promise<void> {
    // Electron session fetch honors the app proxy (same path as model.ts downloads).
    const { session } = await import('electron')
    const headers: Record<string, string> = { 'User-Agent': 'ComfyPilot/0.1' }

    let startByte = 0
    if (existsSync(dest)) {
      try {
        startByte = statSync(dest).size
      } catch {
        startByte = 0
      }
    }
    if (startByte > 0) headers.Range = `bytes=${startByte}-`

    const ac = new AbortController()
    this.aborts.add(ac)
    const timeout = AbortSignal.timeout(15 * 60 * 1000)
    const signal = AbortSignal.any([ac.signal, timeout])
    try {
      const res = await session.defaultSession.fetch(url, {
        headers,
        signal
      })
      if (!res.ok && res.status !== 206) {
        if (res.status === 416 && existsSync(dest) && statSync(dest).size > 0) {
          // Treat as complete ONLY when size is plausible vs hint AND checksum
          // (if pinned) matches. A half-hint is not proof of completeness.
          const size = statSync(dest).size
          const store = loadChecksumStore()
          const pinned = store[url]
          if (sizeHint > 0 && size < sizeHint * 0.9) {
            rmSync(dest, { force: true })
            throw new Error('Cached runtime archive looks truncated — re-downloading')
          }
          if (pinned) {
            const actual = await sha256File(dest)
            if (actual.toLowerCase() !== pinned.toLowerCase()) {
              rmSync(dest, { force: true })
              throw new Error('Cached runtime archive failed checksum — re-downloading')
            }
          }
          return
        }
        throw new Error(`Runtime download failed: HTTP ${res.status} for ${url}`)
      }

      const isAppend = res.status === 206 && startByte > 0
      const totalHeader = Number(res.headers.get('content-length') || 0)
      const totalBytes = isAppend ? startByte + totalHeader : totalHeader || sizeHint

      const tmp = `${dest}.part`
      const fileStream = createWriteStream(tmp, { flags: isAppend ? 'a' : 'w' })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('Runtime download: empty body')

      let received = isAppend ? startByte : 0
      let lastTick = Date.now()
      let lastBytes = received

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
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

  /** Extract zip/tar.gz into destDir (uses PowerShell on Windows, tar/unzip elsewhere). */
  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
    const lower = archivePath.toLowerCase()
    const env = proxyEnv(loadSettings().proxy)
    if (lower.endsWith('.zip')) {
      if (process.platform === 'win32') {
        // Expand-Archive is always present on Windows 10+
        const escaped = (s: string) => s.replace(/'/g, "''")
        await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${escaped(archivePath)}' -DestinationPath '${escaped(destDir)}' -Force`
          ],
          { timeout: 120000, windowsHide: true, maxBuffer: 10 * 1024 * 1024, env }
        )
      } else {
        await execFileAsync('unzip', ['-o', archivePath, '-d', destDir], {
          timeout: 120000,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
          env
        })
      }
      return
    }
    // tar.gz / tgz
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir], {
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env
    })
  }

  /** Best python path for venv creation — portable preferred when system is missing. */
  async resolvePythonForVenv(preference?: string): Promise<string> {
    if (preference && preference.trim() && existsSync(preference.trim())) return preference.trim()
    const st = await this.status()
    if (st.pythonOrigin !== 'missing' && st.pythonPath) return st.pythonPath
    // Last resort: let uv fetch a Python
    const uv = st.components.find((c) => c.kind === 'uv' && c.installed)
    if (uv?.path) return uv.path // caller may use `uv python install` / `uv venv`
    return 'python'
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
