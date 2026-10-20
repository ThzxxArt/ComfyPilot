/**
 * Secret-at-rest helper (0.1.17, WP8).
 *
 * Wraps Electron `safeStorage` (OS keychain) behind a two-function contract so
 * every persisted credential — proxy password, remote API keys — goes through
 * one implementation instead of each module rolling its own `enc:` handling.
 *
 * Fallbacks (documented, not accidental):
 *  - `safeStorage` unavailable (unit tests, very early init) → plaintext, which
 *    keeps existing configs usable; the keychain is an upgrade, not a gate.
 *  - decrypt failure (profile moved to another OS user/machine) → empty string
 *    rather than throwing, so a single unreadable secret cannot brick settings.
 */
import { safeStorage } from 'electron'

const PREFIX = 'enc:'

export function encryptSecret(secret: string): string {
  if (!secret) return ''
  if (secret.startsWith(PREFIX)) return secret // already encrypted (idempotent)
  try {
    if (safeStorage?.isEncryptionAvailable?.()) {
      return PREFIX + safeStorage.encryptString(secret).toString('base64')
    }
  } catch {
    /* no keychain — fall through to plaintext */
  }
  return secret
}

export function decryptSecret(stored: string): string {
  return decryptSecretSafe(stored).value
}

/** True when the value is still ciphertext (round-trip-safe). */
export function isEncryptedSecret(stored: string): boolean {
  return Boolean(stored && stored.startsWith(PREFIX))
}

/**
 * 0.1.17 (review fix): distinguish "empty" from "cannot decrypt".
 *
 * Returning '' for an unreadable secret let the next settings/remote save write
 * that empty value over the ciphertext — the user's key was destroyed by a
 * profile move or a missing keychain. Callers now keep the stored ciphertext
 * when `failed` is true and the incoming value is empty.
 */
export function decryptSecretSafe(stored: string): { value: string; failed: boolean } {
  if (!stored) return { value: '', failed: false }
  if (!stored.startsWith(PREFIX)) return { value: stored, failed: false }
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
    return { value: safeStorage.decryptString(buf), failed: false }
  } catch {
    return { value: '', failed: true }
  }
}
