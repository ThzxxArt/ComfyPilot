import type { RemoteInstanceConfig } from '@shared/types'
import { clearRemoteApiKey, listRemoteSummaries, setRemoteApiKey } from '../../services/db'
import { remoteService } from '../../services/p1p2'
import { isSafeExternalUrl, sanitizeId } from '../../services/security'
import { remoteSummary, wrap } from '../context'

export function createRemoteHandlers() {
  return {
    list: wrap(() => listRemoteSummaries()),
    save: wrap((config: RemoteInstanceConfig) => {
      if (!config?.baseUrl || !isSafeExternalUrl(config.baseUrl)) {
        throw new Error('Remote baseUrl must be a valid http(s) URL')
      }
      // The renderer never receives the secret; a blank field therefore means
      // "keep the existing key" (origin-checked inside upsertRemote), not
      // "clear it". Clearing has an explicit channel.
      if (config.apiKey && /[\r\n\0]/.test(config.apiKey)) throw new Error('Invalid apiKey')
      const { apiKey: _ignored, ...safe } = config
      const saved = remoteService.save(safe)
      return remoteSummary(remoteService.list().find((r) => r.id === saved.id) || saved)
    }),
    setApiKey: wrap((id: string, apiKey: string) => {
      if (typeof apiKey !== 'string' || /[\r\n\0]/.test(apiKey)) {
        throw new Error('Invalid apiKey')
      }
      setRemoteApiKey(sanitizeId(id), apiKey)
      return { ok: true }
    }),
    clearApiKey: wrap((id: string) => {
      clearRemoteApiKey(sanitizeId(id))
      return { ok: true }
    }),
    remove: wrap((id: string) => remoteService.remove(sanitizeId(id))),
    test: wrap((id: string) => remoteService.test(id)),
    listStatus: wrap(() => remoteService.listStatus()),
    freeMemory: wrap(async (id: string) => {
      const remote = remoteService.list().find((r) => r.id === sanitizeId(id))
      if (!remote) throw new Error('Remote not found')
      const { ComfyApiClient } = await import('../../services/comfyApi')
      const ok = await new ComfyApiClient(remote.baseUrl, {
        headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : undefined
      }).freeMemory()
      return ok ? { ok: true } : { ok: false, error: 'Instance did not accept /free' }
    })
  }
}
