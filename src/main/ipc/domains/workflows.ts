import { existsSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { shell } from 'electron'
import { loadInstanceConfigs, loadSettings } from '../../services/db'
import { remoteService } from '../../services/p1p2'
import { isSafeExternalUrl, resolveInsideAnyRoot, sanitizeId } from '../../services/security'
import { workflowService } from '../../services/workflow'
import {
  isSafeReadPath,
  openEmbedInternal,
  requireRunningInstance,
  wrap,
  type IpcContext
} from '../context'
import { requireLocalInstanceId, safeInstanceId, safeInstanceTarget } from '../trust'

export function createWorkflowHandlers(ctx: IpcContext) {
  return {
    list: wrap(async (opts?: { includeMissing?: boolean }) => {
      const list = workflowService.list(opts)
      // Attach a transient content fingerprint so the renderer can widen the
      // workflow→outputs filter across duplicate copies (0.1.11).
      const { fingerprintOfWorkflowFile } = await import('../../services/workflowFingerprint')
      return list.map((w) => ({
        ...w,
        contentHash:
          !w.missing && w.path ? fingerprintOfWorkflowFile(w.path) || undefined : undefined
      }))
    }),
    import: wrap((path: string, instanceId?: string, target?: 'instance' | 'library') => {
      if (!isSafeReadPath(path)) throw new Error('Blocked unsafe workflow path')
      return workflowService.importFile(path, safeInstanceId(instanceId), target || 'instance')
    }),
    importMany: wrap(
      async (paths: string[], instanceId?: string, target?: 'instance' | 'library') => {
        if (!Array.isArray(paths) || !paths.length) return { ok: [], errors: [] }
        for (const p of paths) {
          if (!isSafeReadPath(p)) throw new Error(`Blocked unsafe workflow path: ${basename(p)}`)
        }
        return workflowService.importMany(paths, safeInstanceId(instanceId), target || 'instance')
      }
    ),
    tag: wrap((id: string, tags: string[]) => workflowService.tag(id, tags)),
    favorite: wrap((id: string, favorite: boolean) => workflowService.favorite(id, favorite)),
    rename: wrap((id: string, name: string) => workflowService.rename(id, name)),
    remove: wrap((id: string, opts?: { deleteSource?: boolean }) =>
      workflowService.remove(sanitizeId(id), opts)
    ),
    exportZip: wrap(async (id: string, destDir?: string) => {
      if (destDir) {
        if (!existsSync(destDir)) throw new Error('Export directory does not exist')
        const { workflowLibraryDir, cacheDir } = await import('../../services/db')
        const allowed = [
          join(homedir(), 'Downloads', 'ComfyPilot'),
          workflowLibraryDir(),
          cacheDir(),
          ...loadInstanceConfigs().map((i) => i.path)
        ].filter(Boolean) as string[]
        // resolveInsideAnyRoot collapses `..` (lexical prefix checks let
        // `<allowed>/../Desktop` through on every platform).
        if (!resolveInsideAnyRoot(destDir, allowed)) {
          throw new Error('Export directory is outside the allowed roots')
        }
      }
      return workflowService.exportZip(sanitizeId(id), destDir)
    }),
    copyToInstance: wrap((id: string, instanceId: string) => {
      // Local instances only — a remote target gets the coded refusal, and
      // an empty/unresolvable id must never resolve to another instance
      // (0.1.13).
      const target = requireLocalInstanceId(instanceId)
      if (!target) throw new Error('No instance configured')
      return workflowService.copyToInstance(sanitizeId(id), target)
    }),
    openInFrontend: wrap(async (id: string, instanceId?: string) => {
      // Refuse BEFORE copying anything when the backend is down.
      await requireRunningInstance(instanceId)
      const prepared = await workflowService.prepareFrontend(
        sanitizeId(id),
        safeInstanceId(instanceId)
      )
      const settings = loadSettings()
      const mode: 'embed' | 'browser' = settings.embedFrontend === false ? 'browser' : 'embed'
      if (!isSafeExternalUrl(prepared.url)) throw new Error('Blocked unsafe URL')
      if (mode === 'embed') {
        await openEmbedInternal(ctx, prepared.url, prepared.instanceName)
      } else {
        await shell.openExternal(prepared.url)
      }
      return {
        opened: true,
        mode,
        instanceName: prepared.instanceName,
        url: prepared.url
      }
    }),
    reveal: wrap((id: string) => workflowService.reveal(sanitizeId(id))),
    libraryInfo: wrap((instanceId?: string) =>
      workflowService.libraryInfo(safeInstanceTarget(instanceId))
    ),
    queue: wrap(async (opts: { workflowPath: string; instanceId: string; seed?: number }) => {
      if (!isSafeReadPath(opts?.workflowPath)) throw new Error('Blocked unsafe workflow path')
      const target = safeInstanceTarget(String(opts.instanceId || ''))
      if (!target) throw new Error('Invalid instance id')
      // Queueing needs a live backend — local instance or reachable remote.
      if (target.startsWith('remote:')) {
        const status = await remoteService.test(target.slice('remote:'.length))
        if (!status.online) {
          throw new Error(`Remote instance is offline: ${status.error || target}`)
        }
      } else {
        await requireRunningInstance(target)
      }
      return workflowService.queue({
        workflowPath: opts.workflowPath,
        instanceId: target,
        seed: opts.seed
      })
    }),
    parsePngMeta: wrap((path: string) => {
      if (!isSafeReadPath(path)) throw new Error('Blocked unsafe image path')
      return workflowService.parsePngMeta(path)
    }),
    compare: wrap((idA: string, idB: string) =>
      workflowService.compare(sanitizeId(idA), sanitizeId(idB))
    ),
    preflight: wrap(async (workflowPath: string, instanceId: string) => {
      if (!isSafeReadPath(workflowPath)) throw new Error('Blocked unsafe workflow path')
      const target = safeInstanceTarget(String(instanceId || ''))
      if (!target) throw new Error('Invalid instance id')
      if (target.startsWith('remote:')) {
        // Remote object_info needs auth headers; capabilityService probes local
        // instances only — report honestly as unavailable rather than guessing.
        return {
          available: false,
          missingTypes: [],
          nodeTypes: 0,
          error: 'Preflight is only available for local instances'
        }
      }
      const { preflightService } = await import('../../services/preflight')
      return preflightService.workflow(workflowPath, target)
    }),
    checkModels: wrap(async (workflowPath: string, instanceId?: string) => {
      if (!isSafeReadPath(workflowPath)) throw new Error('Blocked unsafe workflow path')
      const target = safeInstanceTarget(instanceId)
      const { preflightService } = await import('../../services/preflight')
      return preflightService.models(workflowPath, target)
    }),
    importDefault: wrap(async (opts: { instanceId: string; target?: 'instance' | 'library' }) => {
      const raw = String(opts?.instanceId || '')
      if (!raw) throw new Error('No instance selected')
      const target = safeInstanceTarget(raw)
      if (!target || target.startsWith('remote:')) {
        // Local-only: remote auth surface for graph fetches stays out of scope,
        // matching every other instance-targeted workflow import.
        throw new Error('Default workflow import is only available for local instances')
      }
      // The default workflow lives on the RUNNING server — never auto-start.
      await requireRunningInstance(target)
      return workflowService.importDefaultFromInstance(target, opts?.target || 'instance')
    })
  }
}
