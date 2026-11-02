import type { RemoteInstanceConfig } from '@shared/types'
import { decryptSecretSafe, encryptSecret, isEncryptedSecret } from '../secretStorage'
import { credentialOriginForUrl } from '../security'
import { mutateInList, readJsonc, upsertInList, writeJsonc } from './jsonc'

// ---------- Remote ----------
/** Remote ids whose stored apiKey could not be decrypted in this process. */
const lockedRemoteApiKeys = new Set<string>()

export function listRemotes(): RemoteInstanceConfig[] {
  // 0.1.17 (WP8): API keys are encrypted at rest; decrypt on every read so all
  // consumers (test/batch/backup) keep receiving usable values.
  return readJsonc<RemoteInstanceConfig[]>('remote_instances', []).map((r) => {
    if (!r.apiKey) return r
    const d = decryptSecretSafe(r.apiKey)
    if (d.failed) {
      // Do not hand out an empty key as if it were the real one, and remember
      // that saving this record must not overwrite the ciphertext.
      lockedRemoteApiKeys.add(r.id)
      return { ...r, apiKey: '', apiKeyLocked: true }
    }
    lockedRemoteApiKeys.delete(r.id)
    return { ...r, apiKey: d.value }
  })
}

export function upsertRemote(c: RemoteInstanceConfig): void {
  // Encrypt before persisting — `upsertInList` compares by id only, so the
  // stored representation may differ from the in-memory one.
  const previous = readJsonc<RemoteInstanceConfig[]>('remote_instances', []).find(
    (r) => r.id === c.id
  )
  const newOrigin = credentialOriginForUrl(c.baseUrl)
  const previousOrigin = previous
    ? previous.credentialOrigin || credentialOriginForUrl(previous.baseUrl)
    : ''
  let apiKey = String(c.apiKey || '')
  if (!apiKey && previous) {
    // 0.2.0: preserve the existing secret only for the SAME endpoint. A remote
    // renamed to another host/base path must not inherit the old API key.
    if (previousOrigin && previousOrigin === newOrigin) {
      apiKey = previous.apiKey || ''
    }
  }
  const { apiKeyLocked: _ignored, credentialOrigin: _origin, ...rest } = c
  const stored: RemoteInstanceConfig = {
    ...rest,
    credentialOrigin: newOrigin,
    ...(apiKey
      ? { apiKey: isEncryptedSecret(apiKey) ? apiKey : encryptSecret(apiKey) }
      : { apiKey: '' })
  }
  if (apiKey) lockedRemoteApiKeys.delete(c.id)
  upsertInList('remote_instances', stored, (a, b) => a.id === b.id)
}

/** Renderer-safe list: never exposes the API key or its ciphertext. */
export function listRemoteSummaries(): import('@shared/types').RemoteInstanceSummary[] {
  return listRemotes().map(({ apiKey, ...rest }) => ({
    ...rest,
    apiKeySet: Boolean(apiKey) && !rest.apiKeyLocked
  }))
}

/** Explicit credential write (never part of a generic settings/remote save). */
export function setRemoteApiKey(id: string, apiKey: string): void {
  const list = readJsonc<RemoteInstanceConfig[]>('remote_instances', [])
  const remote = list.find((r) => r.id === id)
  if (!remote) throw new Error('Remote not found')
  const next = list.map((r) =>
    r.id === id
      ? {
          ...r,
          apiKey: apiKey ? encryptSecret(String(apiKey)) : '',
          credentialOrigin: credentialOriginForUrl(r.baseUrl),
          apiKeyLocked: false
        }
      : r
  )
  writeJsonc('remote_instances', next, 'ComfyPilot remote instances')
  lockedRemoteApiKeys.delete(id)
}

export function clearRemoteApiKey(id: string): void {
  setRemoteApiKey(id, '')
}

export function deleteRemote(id: string): boolean {
  const before = readJsonc<RemoteInstanceConfig[]>('remote_instances', []).length
  const next = mutateInList<RemoteInstanceConfig>('remote_instances', [], (list) =>
    list.filter((r) => r.id !== id)
  )
  return next.length !== before
}
