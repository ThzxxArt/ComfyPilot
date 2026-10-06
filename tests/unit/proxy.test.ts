import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: { getPath: () => path.join(os.tmpdir(), 'cp-proxy-test') },
    session: {
      defaultSession: {
        setProxy: async () => undefined,
        fetch: async () => ({ ok: true, status: 204 })
      }
    }
  }
})

import {
  buildProxyUrl,
  redactProxyUrl,
  buildBypassList,
  shouldBypass,
  proxyEnv,
  assertSafeProxyHost
} from '../../src/main/services/proxy'
import type { ProxySettings } from '../../src/shared/types'

const base: ProxySettings = {
  enabled: true,
  protocol: 'http',
  host: '127.0.0.1',
  port: 7890,
  username: '',
  password: '',
  bypass: 'example.com, .internal'
}

describe('buildProxyUrl', () => {
  it('builds basic url', () => {
    expect(buildProxyUrl(base)).toBe('http://127.0.0.1:7890')
  })

  it('adds credentials only when requested', () => {
    const withCreds = { ...base, username: 'u', password: 'p@ss' }
    expect(buildProxyUrl(withCreds)).toBe('http://u:p%40ss@127.0.0.1:7890')
    expect(buildProxyUrl(withCreds, { withAuth: false })).toBe('http://127.0.0.1:7890')
  })

  it('redactProxyUrl never includes password', () => {
    const withCreds = { ...base, username: 'u', password: 'supersecret' }
    const red = redactProxyUrl(withCreds)
    expect(red).not.toContain('supersecret')
    expect(red).toBe('http://127.0.0.1:7890')
  })

  it('socks5 scheme', () => {
    expect(buildProxyUrl({ ...base, protocol: 'socks5' })).toBe('socks5://127.0.0.1:7890')
  })

  it('disabled / missing host returns empty', () => {
    expect(buildProxyUrl({ ...base, enabled: false })).toBe('')
    expect(buildProxyUrl({ ...base, host: '' })).toBe('')
  })
})

describe('host validation', () => {
  it('rejects proxyRules injection', () => {
    expect(() => assertSafeProxyHost('h;proxy=x')).toThrow()
    expect(() => assertSafeProxyHost('user@evil')).toThrow()
    expect(() => assertSafeProxyHost('')).toThrow()
    expect(assertSafeProxyHost('127.0.0.1')).toBe('127.0.0.1')
    expect(assertSafeProxyHost('proxy.corp.local')).toBe('proxy.corp.local')
  })
})

describe('bypass', () => {
  it('always includes localhost', () => {
    const list = buildBypassList({ ...base, bypass: '' })
    expect(list).toContain('localhost')
    expect(list).toContain('127.0.0.1')
  })

  it('shouldBypass matches exact and safe suffix', () => {
    const list = buildBypassList(base)
    expect(shouldBypass('http://localhost:8188', list)).toBe(true)
    expect(shouldBypass('http://api.example.com/x', list)).toBe(true)
    expect(shouldBypass('http://[::1]:1/x', list)).toBe(true)
    // single-label bypass must not match suffix (com ≠ evil.com)
    const short = buildBypassList({ ...base, bypass: 'com' })
    expect(shouldBypass('http://evil.com', short)).toBe(false)
    expect(shouldBypass('https://github.com', list)).toBe(false)
  })
})

describe('proxyEnv', () => {
  it('sets HTTP(S)_PROXY and NO_PROXY', () => {
    const env = proxyEnv(base)
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.NO_PROXY).toContain('localhost')
  })

  it('clears proxy vars when disabled', () => {
    process.env.HTTP_PROXY = 'http://x'
    const env = proxyEnv({ ...base, enabled: false })
    expect(env.HTTP_PROXY).toBeUndefined()
    // and must not mutate process.env
    expect(process.env.HTTP_PROXY).toBe('http://x')
    delete process.env.HTTP_PROXY
  })
})

describe('applyProxyToElectron / testProxy', () => {
  it('returns redacted url and applies rules', async () => {
    const { applyProxyToElectron, testProxy, assertSafeProxyPort } = await import(
      '../../src/main/services/proxy'
    )
    const r = applyProxyToElectron({ ...base, username: 'u', password: 'secret' })
    expect(r.enabled).toBe(true)
    expect(r.url).not.toContain('secret')
    expect(() => assertSafeProxyPort(0)).toThrow()
    expect(() => assertSafeProxyPort(70000)).toThrow()
    expect(assertSafeProxyPort(1080)).toBe(1080)

    const t = await testProxy({})
    expect(typeof t.ok).toBe('boolean')
    expect(t.via).not.toContain('secret')
    expect(t.ms).toBeGreaterThanOrEqual(0)
  })
})
