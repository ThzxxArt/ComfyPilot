/**
 * 0.1.17 (WP8): remote instance API keys are encrypted at rest with
 * Electron safeStorage and decrypted on every read.
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { RemoteInstanceConfig } from '../../src/shared/types'

const h = vi.hoisted(() => ({ dir: '', encryption: true }))

vi.mock('electron', () => ({
  app: { getPath: () => h.dir },
  safeStorage: {
    isEncryptionAvailable: () => h.encryption,
    // Stand-in for the OS keychain: reversible, and never the raw bytes.
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => {
      const raw = b.toString('utf-8')
      if (!raw.startsWith('enc:')) throw new Error('unreadable ciphertext')
      return raw.slice(4)
    }
  }
}))

const root = mkdtempSync(join(tmpdir(), 'cp-wp8-secrets-'))
h.dir = root

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function remote(apiKey: string): RemoteInstanceConfig {
  return {
    id: 'r1',
    name: 'Desktop',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey
  } as RemoteInstanceConfig
}

describe('remote API keys at rest', () => {
  it('never writes the plaintext key to remote_instances.jsonc', async () => {
    vi.resetModules()
    h.encryption = true
    const db = await import('../../src/main/services/db')
    db.upsertRemote(remote('sk-live-123456'))
    db.flushPendingWrites()

    const file = join(root, 'data', 'remote_instances.jsonc')
    expect(existsSync(file)).toBe(true)
    const raw = readFileSync(file, 'utf-8')
    expect(raw).not.toContain('sk-live-123456')
    expect(raw).toContain('enc:')

    expect(db.listRemotes()[0].apiKey).toBe('sk-live-123456')
  })

  it('round-trips after re-saving a config read through listRemotes()', async () => {
    vi.resetModules()
    h.encryption = true
    const db = await import('../../src/main/services/db')
    db.upsertRemote(remote('sk-first'))
    const read = db.listRemotes()[0]
    db.upsertRemote({ ...read, name: 'Renamed' })
    db.flushPendingWrites()

    const again = db.listRemotes()[0]
    expect(again.name).toBe('Renamed')
    expect(again.apiKey).toBe('sk-first')
  })

  it('falls back to plaintext only when the OS keychain is unavailable', async () => {
    vi.resetModules()
    h.encryption = false
    const db = await import('../../src/main/services/db')
    db.upsertRemote(remote('sk-no-keychain'))
    db.flushPendingWrites()

    const raw = readFileSync(join(root, 'data', 'remote_instances.jsonc'), 'utf-8')
    expect(raw).toContain('sk-no-keychain')
    expect(db.listRemotes()[0].apiKey).toBe('sk-no-keychain')
  })
})

describe('unreadable secrets are preserved, not erased (review fix)', () => {
  it('marks a locked remote and keeps the ciphertext when the key cannot be decrypted', async () => {
    vi.resetModules()
    h.encryption = true
    const db = await import('../../src/main/services/db')
    // Simulate a profile moved from another machine: valid `enc:` prefix, but
    // the bytes are not decryptable here.
    writeFileSync(
      join(root, 'data', 'remote_instances.jsonc'),
      JSON.stringify([
        {
          id: 'r9',
          name: 'X',
          baseUrl: 'http://127.0.0.1:8188',
          apiKey: 'enc:%%%',
          label: '',
          enabled: true
        }
      ])
    )
    db.flushPendingWrites()
    const read = db.listRemotes()
    expect(read[0].apiKey).toBe('')
    expect(read[0].apiKeyLocked).toBe(true)

    // Saving the config from the UI (empty key field) must not destroy the
    // stored ciphertext.
    db.upsertRemote({ ...read[0], name: 'Renamed' })
    db.flushPendingWrites()
    const raw = JSON.parse(
      readFileSync(join(root, 'data', 'remote_instances.jsonc'), 'utf-8')
    ) as Array<Record<string, unknown>>
    expect(raw[0].apiKey).toBe('enc:%%%')
    expect(raw[0].name).toBe('Renamed')

    // Supplying a new key replaces it normally.
    db.upsertRemote({ ...read[0], apiKey: 'sk-new', apiKeyLocked: false })
    db.flushPendingWrites()
    const after = readFileSync(join(root, 'data', 'remote_instances.jsonc'), 'utf-8')
    expect(after).not.toContain('enc:%%%')
    expect(db.listRemotes()[0].apiKey).toBe('sk-new')
  })

  it('keeps an unreadable proxy password when settings are saved again', async () => {
    vi.resetModules()
    h.encryption = true
    const db = await import('../../src/main/services/db')
    writeFileSync(
      join(root, 'data', 'settings.jsonc'),
      JSON.stringify({ locale: 'zh-CN', proxy: { host: 'h', port: 1, password: 'enc:%%%' } })
    )
    const loaded = db.loadSettings()
    expect(loaded.proxy.password).toBe('')

    db.saveSettings({ minimizeToTray: true })
    db.flushPendingWrites()
    // settings.jsonc carries a `//` header comment — strip it before parsing.
    const text = readFileSync(join(root, 'data', 'settings.jsonc'), 'utf-8')
    const raw = JSON.parse(text.slice(text.indexOf('{'))) as { proxy: { password: string } }
    expect(raw.proxy.password).toBe('enc:%%%')
  })
})

describe('proxy password at rest (review fix)', () => {
  it('encrypts on save and decrypts on load', async () => {
    vi.resetModules()
    h.encryption = true
    const db = await import('../../src/main/services/db')
    db.saveSettings({ proxy: { host: '127.0.0.1', port: 7890, password: 'hunter2' } as never })
    db.flushPendingWrites()
    const text = readFileSync(join(root, 'data', 'settings.jsonc'), 'utf-8')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('enc:')
    expect(db.loadSettings().proxy.password).toBe('hunter2')
  })
})

describe('decryptSecretSafe (review fix)', () => {
  it('reports failure instead of pretending the secret is empty', async () => {
    const sec = await import('../../src/main/services/secretStorage')
    expect(sec.isEncryptedSecret('enc:abc')).toBe(true)
    expect(sec.isEncryptedSecret('plain')).toBe(false)
    expect(sec.decryptSecretSafe('plain')).toEqual({ value: 'plain', failed: false })
    expect(sec.decryptSecretSafe('')).toEqual({ value: '', failed: false })
    const bad = sec.decryptSecretSafe('enc:%%%')
    expect(bad.failed).toBe(true)
    expect(bad.value).toBe('')
    // The string wrapper shares the same code path.
    expect(sec.decryptSecret('plain')).toBe('plain')
    const round = sec.encryptSecret('sk-round')
    expect(sec.isEncryptedSecret(round)).toBe(true)
    expect(sec.decryptSecret(round)).toBe('sk-round')
  })
})
