import { existsSync, readdirSync, statSync, mkdirSync, rmSync, renameSync } from 'fs'
import { join, basename } from 'path'
import type { NodeRecoveryEntry } from '@shared/types'
import type { NodePackHost } from './host'
import { detectCustomNodesRoot, isStrictInside } from './common'

/**
 * 0.1.18 (WP3 / L9): leftovers an interrupted update leaves behind.
 *
 * A registry reinstall renames the live pack to `<name>.bak-<ts>` and then
 * unpacks the new version. If the process dies in that window, `list()`
 * (deliberately) hides `.bak-` entries and the package simply disappears
 * from the UI with no way back. This scan makes those leftovers visible and
 * restorable; it never treats an arbitrary directory as recoverable.
 */
export function scanRecovery(this: NodePackHost, instanceId?: string): NodeRecoveryEntry[] {
  return this.scanRecoveryAt(detectCustomNodesRoot(instanceId))
}

/**
 * 0.2.0: before ComfyUI starts, move every transient/backup entry at the
 * root of custom_nodes into `.disabled/`, which ComfyUI skips. This is a
 * quarantine, not a delete — the recovery center can clean it later.
 */
export function quarantineTransients(this: NodePackHost, instanceId?: string): string[] {
  const root = detectCustomNodesRoot(instanceId)
  if (!root || !existsSync(root)) return []
  const disabled = join(root, '.disabled')
  const moved: string[] = []
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return moved
  }
  for (const name of names) {
    if (!(name.startsWith('._') || name.includes('.trash-') || name.includes('.bak-'))) continue
    const from = join(root, name)
    if (!isStrictInside(from, root)) continue
    try {
      mkdirSync(disabled, { recursive: true })
      let target = join(disabled, name)
      if (existsSync(target)) target = join(disabled, `${name}.${Date.now()}`)
      renameSync(from, target)
      moved.push(name)
    } catch {
      /* a locked directory stays in place; the issue list still shows it */
    }
  }
  return moved
}

export function scanRecoveryAt(this: NodePackHost, root: string): NodeRecoveryEntry[] {
  if (!root || !existsSync(root)) return []
  const out: NodeRecoveryEntry[] = []
  const info = (p: string): number => {
    try {
      return statSync(p).mtimeMs
    } catch {
      return 0
    }
  }
  const sizeOf = (p: string, budget = { n: 5000 }): number => {
    try {
      const st = statSync(p)
      if (st.isFile()) return st.size
      if (!st.isDirectory()) return 0
    } catch {
      return 0
    }
    let total = 0
    try {
      for (const child of readdirSync(p)) {
        if (budget.n-- <= 0) break
        total += sizeOf(join(p, child), budget)
      }
    } catch {
      /* unreadable child */
    }
    return total
  }
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  for (const name of names) {
    if (!name || name === '.' || name === '..') continue
    const abs = join(root, name)
    if (!isStrictInside(abs, root)) continue
    if (name.startsWith('._')) {
      out.push({
        kind: 'temp',
        name,
        packName: '',
        path: abs,
        livePath: '',
        liveExists: false,
        mtimeMs: info(abs),
        sizeBytes: sizeOf(abs)
      })
      continue
    }
    // A `.trash-*` at the root is a legacy 0.1.x residue. It is never
    // restorable but must be visible/cleanable.
    if (name.includes('.trash-')) {
      out.push({
        kind: 'trash',
        name,
        packName: '',
        path: abs,
        livePath: '',
        liveExists: false,
        mtimeMs: info(abs),
        sizeBytes: sizeOf(abs)
      })
      continue
    }
    const idx = name.lastIndexOf('.bak-')
    if (idx > 0 && idx < name.length - 5) {
      const packName = name.slice(0, idx)
      const live = join(root, packName)
      out.push({
        kind: 'backup',
        name,
        packName,
        path: abs,
        livePath: live,
        liveExists: existsSync(live),
        mtimeMs: info(abs),
        sizeBytes: sizeOf(abs)
      })
    }
  }
  // A pack present both live and inside `.disabled/` is a half-applied
  // toggle: the disabled copy is never loaded but keeps disk + confusion.
  const disabledRoot = join(root, '.disabled')
  if (existsSync(disabledRoot)) {
    try {
      for (const name of readdirSync(disabledRoot)) {
        const live = join(root, name)
        const abs = join(disabledRoot, name)
        if (!isStrictInside(abs, disabledRoot)) continue
        // Quarantined leftovers live here (ComfyUI skips `.disabled`).
        if (name.includes('.trash-')) {
          out.push({
            kind: 'trash',
            name: `.disabled/${name}`,
            packName: '',
            path: abs,
            livePath: '',
            liveExists: false,
            mtimeMs: info(abs),
            sizeBytes: sizeOf(abs)
          })
          continue
        }
        if (name.includes('.bak-')) {
          const idx = name.lastIndexOf('.bak-')
          const packName = idx > 0 ? name.slice(0, idx) : name
          out.push({
            kind: 'backup',
            name: `.disabled/${name}`,
            packName,
            path: abs,
            livePath: join(root, packName),
            liveExists: existsSync(join(root, packName)),
            mtimeMs: info(abs),
            sizeBytes: sizeOf(abs)
          })
          continue
        }
        if (!existsSync(live)) continue
        out.push({
          kind: 'duplicate',
          // POSIX separator on purpose: recoveryEntry only accepts the
          // literal `.disabled/` prefix (join would emit a backslash on
          // Windows and make the row un-cleanable).
          name: `.disabled/${name}`,
          packName: name,
          path: abs,
          livePath: live,
          liveExists: true,
          mtimeMs: info(abs),
          sizeBytes: sizeOf(abs)
        })
      }
    } catch {
      /* unreadable .disabled dir → nothing extra to report */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Restore one `.bak-<ts>` entry to its live path (never overwrites a pack). */
export function restoreRecovery(
  this: NodePackHost,
  name: string,
  instanceId?: string
): NodeRecoveryEntry {
  const root = detectCustomNodesRoot(instanceId)
  if (!root) throw new Error('No custom_nodes directory for this instance')
  const entry = this.recoveryEntry(root, name)
  if (!entry) throw new Error('Not a recoverable backup')
  if (entry.kind !== 'backup') throw new Error('Only update backups can be restored')
  if (existsSync(entry.livePath)) {
    const e = new Error(`A pack already exists at ${entry.livePath}`) as Error & { code?: string }
    e.code = 'RECOVERY_TARGET_EXISTS'
    throw e
  }
  renameSync(entry.path, entry.livePath)
  this.opLog?.(`restored ${entry.packName} from ${basename(entry.path)}`, instanceId)
  return {
    ...entry,
    kind: 'backup',
    name: entry.packName,
    path: entry.livePath,
    liveExists: true
  }
}

/** Delete one leftover entry. Only entries the scan would report are allowed. */
export function cleanRecovery(this: NodePackHost, name: string, instanceId?: string): boolean {
  const root = detectCustomNodesRoot(instanceId)
  if (!root) throw new Error('No custom_nodes directory for this instance')
  const entry = this.recoveryEntry(root, name)
  if (!entry) throw new Error('Not a recoverable entry')
  rmSync(entry.path, { recursive: true, force: true })
  this.opLog?.(`cleaned leftover ${entry.name}`, instanceId)
  return true
}

/** Clean every scanned leftover. Returns the number removed and failures. */
export function cleanAllRecovery(
  this: NodePackHost,
  instanceId?: string
): { removed: number; failed: string[] } {
  const entries = this.scanRecovery(instanceId)
  const failed: string[] = []
  let removed = 0
  for (const entry of entries) {
    try {
      this.cleanRecovery(entry.name, instanceId)
      removed += 1
    } catch (err) {
      failed.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { removed, failed }
}

/** Resolve one scanned entry by name, refusing path traversal. */
export function recoveryEntry(
  this: NodePackHost,
  root: string,
  name: string
): NodeRecoveryEntry | undefined {
  if (!name || name.includes('\\') || name.includes('\0')) return undefined
  // The only slash we accept is the fixed `.disabled/` prefix produced by
  // scanRecoveryAt for duplicate entries — never a caller-supplied path.
  const bare = name.startsWith('.disabled/') ? name.slice('.disabled/'.length) : name
  if (!bare || bare === '.' || bare === '..' || bare.includes('/')) return undefined
  return this.scanRecoveryAt(root).find((e) => e.name === name)
}

export const recoveryMethods = {
  scanRecovery,
  quarantineTransients,
  scanRecoveryAt,
  restoreRecovery,
  cleanRecovery,
  cleanAllRecovery,
  recoveryEntry
}
