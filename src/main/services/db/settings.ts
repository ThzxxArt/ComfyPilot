import { DEFAULT_SETTINGS } from '@shared/constants'
import type { AppSettings } from '@shared/types'
import { decryptSecretSafe, encryptSecret, isEncryptedSecret } from '../secretStorage'
import { proxyCredentialOrigin } from '../security'
import { readJsonc, writeJsonc } from './jsonc'

// ---------- Settings ----------
const SETTINGS_HEADER = `ComfyPilot settings (JSONC)
// Edit safely — comments are allowed. Saved as <userData>/data/settings.jsonc`

/**
 * 0.1.17 (review fix): set when the stored proxy password could not be decrypted
 * on this machine. `saveSettings` then keeps the ciphertext instead of writing
 * an empty password over it.
 */
let proxyPasswordUnreadable = false

/** 0.1.18 (WP1 / S6): surface "the stored proxy password cannot be decrypted". */
export function isProxyPasswordUnreadable(): boolean {
  return proxyPasswordUnreadable
}

export function loadSettings(): AppSettings {
  const stored = readJsonc<Partial<AppSettings>>('settings', {})
  const proxy = { ...DEFAULT_SETTINGS.proxy, ...(stored.proxy || {}) }
  // Decrypt the password if it was stored encrypted.
  const decrypted = decryptSecretSafe(proxy.password)
  proxyPasswordUnreadable = decrypted.failed
  proxy.password = decrypted.value
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    proxy
  }
}

/** Known top-level AppSettings keys — unknown keys are stripped on save. */
const KNOWN_SETTINGS_KEYS = new Set([
  'locale',
  'modelScanRoots',
  'githubEndpoint',
  'hfEndpoint',
  'civitaiEndpoint',
  'enableAutoCheckUpdates',
  'embedFrontend',
  'securityLevel',
  'allowGitUrlInstall',
  'allowPipInstall',
  'networkMode',
  'aria2Path',
  'useAria2',
  'launchOnBoot',
  'minimizeToTray',
  'autoStartInstancesOnLaunch',
  'proxy',
  'pipIndex',
  'torchIndexMirror',
  'outputScanDepth',
  'stopMode',
  'allowUnverifiedRuntime'
])

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  // Strip unknown keys to prevent dirty data from accumulating.
  const cleanPatch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (KNOWN_SETTINGS_KEYS.has(k)) cleanPatch[k] = v
  }
  const incomingProxy = (cleanPatch.proxy || {}) as Partial<AppSettings['proxy']>
  const nextProxy = { ...current.proxy, ...incomingProxy }
  // 0.2.0: a credential belongs to one endpoint. Never carry the stored
  // password to a different protocol/host/port/username.
  const currentOrigin = proxyCredentialOrigin(current.proxy)
  const nextOrigin = proxyCredentialOrigin(nextProxy)
  const suppliedPassword =
    typeof incomingProxy.password === 'string' && incomingProxy.password.length > 0
  let password = suppliedPassword ? String(incomingProxy.password) : ''
  if (!suppliedPassword) {
    if (nextOrigin === currentOrigin) password = current.proxy.password
    // 0.1.17: an unreadable secret must never be replaced by the empty string
    // the UI shows. Keep the stored ciphertext unless a new password arrived.
    if (!password && proxyPasswordUnreadable && nextOrigin === currentOrigin) {
      const stored = readJsonc<Partial<AppSettings>>('settings', {})
      const raw = String(stored.proxy?.password || '')
      if (isEncryptedSecret(raw)) password = raw
    }
  }
  const next: AppSettings = {
    ...current,
    ...cleanPatch,
    proxy: { ...nextProxy, password, credentialOrigin: nextOrigin }
  }
  // Encrypt the password before persisting.
  const toWrite: AppSettings = {
    ...next,
    proxy: { ...next.proxy, password: encryptSecret(password) }
  }
  writeJsonc('settings', toWrite, SETTINGS_HEADER)
  return next
}

/**
 * 0.2.0: explicit proxy password write/clear. Kept separate from
 * `saveSettings` so a generic settings patch can never overwrite a credential
 * by omission, and the renderer never needs to receive the current password.
 */
export function setProxyPassword(password: string): void {
  const current = loadSettings()
  const origin = proxyCredentialOrigin(current.proxy)
  const toWrite: AppSettings = {
    ...current,
    proxy: {
      ...current.proxy,
      password: encryptSecret(String(password || '')),
      credentialOrigin: origin
    }
  }
  writeJsonc('settings', toWrite, SETTINGS_HEADER)
  proxyPasswordUnreadable = false
}

export function clearProxyPassword(): void {
  setProxyPassword('')
}
