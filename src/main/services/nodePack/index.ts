import { EventEmitter } from 'events'
import type { NodePackRecord, UpdateProgress } from '@shared/types'
import type { NodePackPublicApi } from './host'
import type { OpBatchState } from './types'
import { opsMethods } from './ops'
import { listMethods } from './list'
import { installMethods } from './install'
import { updateMethods } from './update'
import { depsMethods } from './deps'
import { recoveryMethods } from './recovery'

// Declaration merging adds the mixin methods to the class instance type.
export interface NodePackService extends NodePackPublicApi {}

/**
 * Node pack service. The domain implementations live in sibling modules and
 * are attached to the prototype below; this class owns the single copy of the
 * shared per-instance state they operate on.
 */
// eslint-disable-next-line no-redeclare
export class NodePackService extends EventEmitter {
  // ---- UpdateProgress-shaped stream (feeds the shared progress modal) ----
  /**
   * Per-instance progress streams. A single shared object made concurrent
   * installs/updates on different instances overwrite each other's steps.
   */
  readonly opProgressMap = new Map<string, UpdateProgress & { updatedAt?: number }>()

  /**
   * Batch update contexts per instance. Deliberately OUTSIDE opProgressMap so
   * the per-pack stream reset in update()/install() never erases batch state.
   */
  readonly opBatches = new Map<string, OpBatchState>()

  /**
   * Active install/update abort controllers, keyed by instance (or 'default').
   * cancelOp() aborts the in-flight clone/pip/download for that instance.
   */
  readonly opAborts = new Map<string, AbortController>()

  /**
   * 0.1.18 (WP4): `list()` re-read pack metadata straight off disk for every
   * caller (26 packs → 1.4 s), and it is called on refresh, check, update,
   * toggle and snapshot. Cache the computed records against a directory+mtime
   * signature; any add/remove/rename or pack edit invalidates it naturally.
   */
  readonly listCache = new Map<string, { sig: string; packs: NodePackRecord[] }>()
}

Object.assign(
  NodePackService.prototype,
  opsMethods,
  listMethods,
  installMethods,
  updateMethods,
  depsMethods,
  recoveryMethods
)

export const nodePackService = new NodePackService()

export { compareVersions, isUpdateAvailable } from '@shared/version'
export {
  parseRequirementNames,
  resolveGitBinary,
  gitAvailable,
  resolveGitBinaryAsync,
  resolveRepoUrl,
  isStrictInside,
  sanitizeInstallNameForTest,
  resolveInstanceConfig,
  resolveNestedPackDir
} from './common'
