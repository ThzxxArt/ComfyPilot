import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockLoadSettings, sessionState } = vi.hoisted(() => {
  const sessionState = {
    fetchImpl: async () => ({ ok: true, status: 204 }) as Response,
    setProxyCalls: [] as unknown[],
    setProxyThrows: false
  }
  const mockLoadSettings = vi.fn(() => ({
    proxy: {
      enabled: true,
      protocol: 'http' as const,
      host: '127.0.0.1',
      port: 7890,
      username: '',
      password: '',
      bypass: 'example.com, .internal'
    }
  }))
  return { mockLoadSettings, sessionState }
})

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: { getPath: () => path.join(os.tmpdir(), 'cp-proxy-test') },
    session: {
      defaultSession: {
        setProxy: (settings: unknown) => {
          // sync throw (not a rejected promise) so callers' try/catch is exercised
          if (sessionState.setProxyThrows) throw new Error('setProxy sync throw')
          sessionState.setProxyCalls.push(settings)
          return Promise.resolve()
        },
        fetch: async (...args: unknown[]) => sessionState.fetchImpl(...(args as []))
      }
    }
  }
})

vi.mock('../../src/main/services/db', () => ({
  loadSettings: mockLoadSettings
}))

import {
  buildProxyUrl,
  redactProxyUrl,
  buildBypassList,
  shouldBypass,
  proxyEnv,
  assertSafeProxyHost,
  applyProxyToElectron,
  testProxy,
  assertSafeProxyPort,
  fetchThroughProxy,
  syncProxyFromSettings
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

beforeEach(() => {
  mockLoadSettings.mockClear()
  sessionState.setProxyCalls.length = 0
  sessionState.setProxyThrows = false
  sessionState.fetchImpl = async () => ({ ok: true, status: 204 }) as Response
})

describe('buildProxyUrl', () => {
  it('builds basic url', () => {
    expect(buildProxyUrl(base)).toBe('http://127.0.0.1:7890')
  })

  it('adds credentials only when requested', () => {
    const withCreds = { ...base, username: 'u', password: 'p@ss' }
    expect(buildProxyUrl(withCreds)).toBe('http://u:p%40ss@127.0.0.1:7890')
    expect(buildProxyUrl(withCreds, { withAuth: false })).toBe('http://127.0.0.1:7890')
  })

  it('omits password separator when only username is set', () => {
    expect(buildProxyUrl({ ...base, username: 'u', password: '' })).toBe(
      'http://u@127.0.0.1:7890'
    )
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

  it('https scheme', () => {
    expect(buildProxyUrl({ ...base, protocol: 'https' })).toBe('https://127.0.0.1:7890')
  })

  it('disabled / missing host returns empty', () => {
    expect(buildProxyUrl({ ...base, enabled: false })).toBe('')
    expect(buildProxyUrl({ ...base, host: '' })).toBe('')
    expect(buildProxyUrl({ ...base, port: 0 })).toBe('')
    expect(buildProxyUrl({ ...base, host: '', port: 0 })).toBe('')
  })
})

describe('host validation', () => {
  it('rejects proxyRules injection', () => {
    expect(() => assertSafeProxyHost('h;proxy=x')).toThrow()
    expect(() => assertSafeProxyHost('user@evil')).toThrow()
    expect(() => assertSafeProxyHost('')).toThrow()
    expect(() => assertSafeProxyHost('  ')).toThrow()
    expect(() => assertSafeProxyHost('a\\b')).toThrow()
    expect(() => assertSafeProxyHost('a/b')).toThrow()
    expect(() => assertSafeProxyHost('a b')).toThrow()
    expect(assertSafeProxyHost('127.0.0.1')).toBe('127.0.0.1')
    expect(assertSafeProxyHost('proxy.corp.local')).toBe('proxy.corp.local')
    expect(assertSafeProxyHost(' proxy.corp.local ')).toBe('proxy.corp.local')
  })

  it('rejects invalid ports', () => {
    expect(() => assertSafeProxyPort(0)).toThrow()
    expect(() => assertSafeProxyPort(70000)).toThrow()
    expect(() => assertSafeProxyPort(1.5)).toThrow()
    expect(() => assertSafeProxyPort(NaN)).toThrow()
    expect(assertSafeProxyPort(1080)).toBe(1080)
  })
})

describe('bypass', () => {
  it('always includes localhost', () => {
    const list = buildBypassList({ ...base, bypass: '' })
    expect(list).toContain('localhost')
    expect(list).toContain('127.0.0.1')
  })

  it('deduplicates and trims extra separators', () => {
    const list = buildBypassList({ ...base, bypass: 'a.com, a.com;;b.com  c.com' })
    expect(list.split(';').filter((s) => s === 'a.com')).toHaveLength(1)
    expect(list).toContain('b.com')
    expect(list).toContain('c.com')
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

  it('shouldBypass handles dotted prefix entries and invalid urls', () => {
    // Leading dot is stripped; single-label entries still only exact-match
    // (same rule that keeps `com` from matching evil.com).
    const dotted = buildBypassList({ ...base, bypass: '.internal' })
    expect(shouldBypass('http://internal', dotted)).toBe(true)
    expect(shouldBypass('http://svc.internal', dotted)).toBe(false)

    const dottedMulti = buildBypassList({ ...base, bypass: '.example.com' })
    expect(shouldBypass('http://api.example.com', dottedMulti)).toBe(true)

    expect(shouldBypass('not-a-url', dotted)).toBe(false)
    expect(shouldBypass('', dotted)).toBe(false)
    expect(shouldBypass('http://x', '')).toBe(false)
    expect(shouldBypass('http://x', ';;;')).toBe(false)
    expect(shouldBypass('http://x', 'localhost;  ')).toBe(false)
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

  it('sets ALL_PROXY only for socks5', () => {
    const socks = proxyEnv({ ...base, protocol: 'socks5' })
    expect(socks.ALL_PROXY).toBe('socks5://127.0.0.1:7890')
    expect(socks.all_proxy).toBe('socks5://127.0.0.1:7890')

    const http = proxyEnv(base)
    expect(http.ALL_PROXY).toBeUndefined()
    expect(http.all_proxy).toBeUndefined()
  })

  it('never poisons env when proxy config is invalid', () => {
    const badHost = proxyEnv({ ...base, host: 'h;evil' })
    expect(badHost.HTTP_PROXY).toBeUndefined()
    expect(badHost.http_proxy).toBeUndefined()

    const badPort = proxyEnv({ ...base, port: 99999 })
    expect(badPort.HTTP_PROXY).toBeUndefined()

    const emptyUrl = proxyEnv({ ...base, host: '' })
    expect(emptyUrl.HTTP_PROXY).toBeUndefined()
  })
})

describe('applyProxyToElectron / testProxy / syncProxyFromSettings', () => {
  it('returns redacted url and applies rules', async () => {
    const r = applyProxyToElectron({ ...base, username: 'u', password: 'secret' })
    expect(r.enabled).toBe(true)
    expect(r.url).not.toContain('secret')
    expect(r.bypass).toContain('localhost')
    expect(sessionState.setProxyCalls.length).toBeGreaterThan(0)
  })

  it('falls back to direct when disabled or incomplete', () => {
    const off = applyProxyToElectron({ ...base, enabled: false })
    expect(off.enabled).toBe(false)
    expect(off.url).toBe('')

    const noPort = applyProxyToElectron({ ...base, port: 0 })
    expect(noPort.enabled).toBe(false)

    const last = sessionState.setProxyCalls.at(-1) as { mode: string }
    expect(last.mode).toBe('direct')
  })

  it('uses socks scheme for socks5 electron rules', () => {
    applyProxyToElectron({ ...base, protocol: 'socks5' })
    const last = sessionState.setProxyCalls.at(-1) as { proxyRules: string }
    expect(last.proxyRules).toBe('socks://127.0.0.1:7890')
  })

  it('testProxy reports success and failure without leaking secrets', async () => {
    mockLoadSettings.mockReturnValue({
      proxy: { ...base, username: 'u', password: 'secret' }
    } as never)

    sessionState.fetchImpl = async () => ({ ok: true, status: 204 }) as Response
    const t = await testProxy({})
    expect(t.ok).toBe(true)
    expect(t.via).not.toContain('secret')
    expect(t.ms).toBeGreaterThanOrEqual(0)

    sessionState.fetchImpl = async () => ({ ok: false, status: 204 }) as Response
    const t204 = await testProxy({ url: 'https://example.com/generate_204' })
    expect(t204.ok).toBe(true)

    sessionState.fetchImpl = async () => ({ ok: false, status: 302 }) as Response
    const t302 = await testProxy({})
    expect(t302.ok).toBe(true)

    sessionState.fetchImpl = async () => ({ ok: false, status: 500 }) as Response
    const t500 = await testProxy({})
    expect(t500.ok).toBe(false)

    sessionState.fetchImpl = async () => {
      throw new Error('network down')
    }
    const fail = await testProxy({})
    expect(fail.ok).toBe(false)
    expect(fail.error).toBe('network down')
    expect(fail.via).not.toContain('secret')
  })

  it('testProxy treats non-Error throws as strings', async () => {
    sessionState.fetchImpl = async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'boom'
    }
    const fail = await testProxy({})
    expect(fail.ok).toBe(false)
    expect(fail.error).toBe('boom')
  })

  it('fetchThroughProxy blocks unsafe URLs', async () => {
    await expect(fetchThroughProxy('file:///etc/passwd')).rejects.toThrow(/unsafe/i)
    await expect(fetchThroughProxy('javascript:alert(1)')).rejects.toThrow(/unsafe/i)
    const res = await fetchThroughProxy('https://example.com', { method: 'HEAD' })
    expect(res.ok).toBe(true)
  })

  it('syncProxyFromSettings applies and falls back cleanly', () => {
    mockLoadSettings.mockReturnValue({ proxy: base } as never)
    const ok = syncProxyFromSettings()
    expect(ok.enabled).toBe(true)
    expect(ok.url).toContain('127.0.0.1')

    mockLoadSettings.mockImplementation(() => {
      throw new Error('db unreadable')
    })
    const fallback = syncProxyFromSettings()
    expect(fallback.enabled).toBe(false)
    expect(fallback.url).toBe('')

    mockLoadSettings.mockReturnValue({
      proxy: { ...base, host: 'bad;host' }
    } as never)
    const invalid = syncProxyFromSettings()
    expect(invalid.enabled).toBe(false)

    // inner fallback setProxy throws synchronously → still returns direct
    mockLoadSettings.mockReturnValue({
      proxy: { ...base, host: 'bad;host' }
    } as never)
    sessionState.setProxyThrows = true
    const stillDirect = syncProxyFromSettings()
    expect(stillDirect.enabled).toBe(false)
    expect(stillDirect.url).toBe('')
    sessionState.setProxyThrows = false

    mockLoadSettings.mockReturnValue({ proxy: base } as never)
    const again = syncProxyFromSettings()
    expect(again.enabled).toBe(true)
  })
})
