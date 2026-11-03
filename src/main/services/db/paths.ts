/**
 * Filesystem roots for ComfyPilot persistent state.
 *
 * Every directory is created lazily under Electron's userData path. The legacy
 * cache migration lives here because it is a path-lifecycle concern; the data
 * schema migration is in `migration.ts`.
 */
import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from 'fs'

// ---------- Paths ----------

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function userDataDir(): string {
  return ensureDir(join(app.getPath('userData'), 'data'))
}

/**
 * ComfyPilot-managed portable runtimes (uv, portable CPython, MinGit).
 * Lives next to `data/`, not inside it: these are large binaries, not
 * user-editable configuration.
 */
export function runtimesDir(): string {
  return ensureDir(join(app.getPath('userData'), 'runtimes'))
}

/**
 * uv's managed CPython store, pinned inside ComfyPilot's runtimes tree.
 *
 * Without this, `uv python install` writes to the user's global uv store and
 * an instance venv silently depends on a directory ComfyPilot does not own
 * (or back up). New installs/repairs set `UV_PYTHON_INSTALL_DIR` to this path.
 */
export function uvPythonInstallDir(): string {
  return ensureDir(join(runtimesDir(), 'uv-python'))
}

/**
 * Cache root for regenerable ComfyPilot data (thumbnails, registry index).
 *
 * MUST NOT be `<userData>/cache`: on Windows/macOS the filesystem is
 * case-insensitive, so that path IS Chromium's own `Cache` directory —
 * browser cache eviction (or upgrade) wipes our thumbs with it. 0.1.9 moved
 * the root to `app-cache` and migrates legacy data once on first access.
 */
export function cacheDir(): string {
  const root = join(app.getPath('userData'), 'app-cache')
  migrateLegacyCache(app.getPath('userData'), root)
  return ensureDir(root)
}

let legacyCacheMigrated = false

/** One-shot best-effort move of `cache/thumbs` + registry index into app-cache. */
function migrateLegacyCache(userData: string, nextRoot: string): void {
  if (legacyCacheMigrated) return
  legacyCacheMigrated = true
  try {
    const legacyRoot = join(userData, 'cache')
    if (legacyRoot === nextRoot || !existsSync(legacyRoot)) return
    for (const name of ['thumbs', 'registry-index.json', 'registry-index.json.tmp']) {
      moveLegacyEntry(join(legacyRoot, name), join(nextRoot, name))
    }
  } catch {
    /* best effort — a failed migration only costs regenerating thumbs */
  }
}

function moveLegacyEntry(from: string, to: string): void {
  try {
    if (!existsSync(from)) return
    const st = lstatSync(from)
    // Never descend into symlinks/junctions: statSync would follow them and
    // move the LINK TARGET's contents out of the user's real directory.
    if (st.isSymbolicLink()) return
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true })
      for (const name of readdirSync(from)) moveLegacyEntry(join(from, name), join(to, name))
    } else if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true })
      renameSync(from, to)
    }
  } catch {
    /* skip individual entries that resist moving */
  }
}

export function logsDir(): string {
  return ensureDir(join(app.getPath('userData'), 'logs'))
}

export function backupDir(): string {
  return ensureDir(join(userDataDir(), 'backups'))
}

export function snapshotDir(): string {
  return ensureDir(join(userDataDir(), 'node-snapshots'))
}

/** Config directory for human-editable jsonc (same as userDataDir). */
export function configDir(): string {
  return userDataDir()
}

/**
 * Legacy ComfyPilot workflow folder (`<userData>/data/workflows`).
 * Imports now land in the instance's `user/default/workflows`; this directory
 * is still scanned so files from older releases stay visible.
 */
export function workflowLibraryDir(): string {
  return ensureDir(join(userDataDir(), 'workflows'))
}
