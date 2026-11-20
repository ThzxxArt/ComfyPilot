/**
 * Main-process path capabilities (0.2.5 WP10).
 *
 * The old security model kept three global Sets of "approved" roots that any
 * caller could add to, and `settings.set({ modelScanRoots: ['/'] })` therefore
 * became a renderer-controlled global read/write grant. Capabilities are
 * issued by a trusted main-process action (OS picker, discovery, validated
 * instance/installer path), carry an explicit scope and expire.
 */
import { randomUUID } from 'crypto'
import { lstatSync, realpathSync } from 'fs'
import { dirname, resolve } from 'path'
import { isPathInside, normalizeForCompare, resolveInsideAnyRoot } from './security'

export type PathCapabilityScope = 'read' | 'write' | 'exec'
export type PathCapabilitySource = 'picker' | 'discovery' | 'instance' | 'installer' | 'system'

export interface PathCapability {
  id: string
  root: string
  scope: PathCapabilityScope
  source: PathCapabilitySource
  expiresAt: number
  /** Optional instance scope: an instance-bound grant cannot authorise another. */
  instanceId?: string
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function isSymlinkRoot(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export class PathCapabilityStore {
  private readonly caps = new Map<string, PathCapability>()

  issue(
    root: string,
    scope: PathCapabilityScope,
    source: PathCapabilitySource,
    opts?: { ttlMs?: number; instanceId?: string }
  ): PathCapability {
    if (!root || root.includes('\0')) throw new Error('Invalid capability path')
    const capability: PathCapability = {
      id: randomUUID(),
      root: normalizeForCompare(root),
      scope,
      source,
      expiresAt: Date.now() + Math.max(1, opts?.ttlMs ?? DEFAULT_TTL_MS),
      instanceId: opts?.instanceId
    }
    this.caps.set(capability.id, capability)
    return capability
  }

  issueAll(
    root: string,
    source: PathCapabilitySource,
    opts?: { ttlMs?: number; instanceId?: string }
  ): PathCapability[] {
    return (['read', 'write', 'exec'] as const).map((scope) =>
      this.issue(root, scope, source, opts)
    )
  }

  revoke(id: string): boolean {
    return this.caps.delete(id)
  }

  revokeAll(): void {
    this.caps.clear()
  }

  list(scope?: PathCapabilityScope): PathCapability[] {
    this.prune()
    return [...this.caps.values()].filter((c) => (scope ? c.scope === scope : true))
  }

  /** Roots currently valid for a scope (used by legacy read-only allow-lists). */
  rootsFor(scope: PathCapabilityScope): string[] {
    return [...new Set(this.list(scope).map((c) => c.root))]
  }

  /**
   * True when `candidate` resolves inside a live capability for this scope.
   * Existing paths are resolved (symlinks) before containment; write targets
   * that do not exist yet are checked lexically against their real parent.
   */
  covers(
    candidate: string,
    scope: PathCapabilityScope,
    opts?: { instanceId?: string }
  ): boolean {
    if (!candidate || candidate.includes('\0')) return false
    this.prune()
    const target = realpathOrSelf(candidate)
    for (const cap of this.caps.values()) {
      if (cap.scope !== scope) continue
      if (opts?.instanceId && cap.instanceId && cap.instanceId !== opts.instanceId) continue
      const root = realpathOrSelf(cap.root)
      if (target === root || isPathInside(target, root)) return true
    }
    if (scope === 'write') {
      // Resolve the nearest existing ancestor so a not-yet-created file is
      // validated against the same (real) root it will live under.
      let parent = dirname(resolve(candidate))
      for (let i = 0; i < 8; i++) {
        const realParent = realpathOrSelf(parent)
        for (const cap of this.caps.values()) {
          if (cap.scope !== 'write') continue
          if (opts?.instanceId && cap.instanceId && cap.instanceId !== opts.instanceId) continue
          const root = realpathOrSelf(cap.root)
          if (realParent === root || isPathInside(realParent, root)) return true
        }
        const next = dirname(parent)
        if (next === parent) break
        parent = next
      }
    }
    return false
  }

  /** Reject a symlinked root (output/thumb/export-script containment). */
  static assertNotSymlinkRoot(root: string): void {
    if (isSymlinkRoot(root)) throw new Error(`Refusing symlinked root: ${root}`)
  }

  /** Lexical containment for a path that must be created under a real root. */
  static resolveUnder(candidate: string, root: string): string | null {
    if (!candidate || !root) return null
    const realRoot = realpathOrSelf(root)
    const lexical = resolveInsideAnyRoot(candidate, [realRoot])
    if (!lexical) return null
    return lexical
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, cap] of this.caps) if (cap.expiresAt <= now) this.caps.delete(id)
  }
}

export const pathCapabilities = new PathCapabilityStore()
