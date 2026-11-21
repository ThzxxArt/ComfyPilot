/**
 * 0.1.18 regression: the settings validator must cover every field that is
 * later interpolated into a URL (proxy.protocol) or executed (aria2Path).
 */
import { describe, it, expect } from 'vitest'
import {
  assertSafeSettingsPatch,
  isAllowedListenHost,
  isAllowedListenList
} from '../../src/main/services/security'

describe('assertSafeSettingsPatch — proxy', () => {
  it('accepts the supported protocols', () => {
    for (const protocol of ['http', 'https', 'socks5']) {
      expect(() =>
        assertSafeSettingsPatch({
          proxy: { enabled: true, host: '127.0.0.1', port: 7890, protocol }
        })
      ).not.toThrow()
    }
  })

  it('rejects an unknown protocol (used to silently disable the proxy)', () => {
    for (const protocol of ['socks5h', '', 'http://evil:8080;http']) {
      expect(() =>
        assertSafeSettingsPatch({
          proxy: { enabled: true, host: '127.0.0.1', port: 7890, protocol }
        })
      ).toThrow(/proxy\.protocol/)
    }
  })

  it('requires a host when the proxy is enabled', () => {
    expect(() => assertSafeSettingsPatch({ proxy: { enabled: true, port: 7890 } })).toThrow(
      /proxy\.host/
    )
    expect(() =>
      assertSafeSettingsPatch({ proxy: { enabled: true, host: 'a;b', port: 7890 } })
    ).toThrow(/illegal characters/)
  })
})

describe('isAllowedListenHost / list', () => {
  it('accepts literal loopback/wildcard/private-LAN addresses', () => {
    for (const host of [
      '0.0.0.0',
      '::',
      '*',
      '::1',
      '[::1]',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.5',
      '172.16.0.1',
      '172.31.255.1',
      '100.64.0.1',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      'fe9f::1',
      'fea0::1',
      'febf::1'
    ]) {
      expect(isAllowedListenHost(host), host).toBe(true)
    }
  })

  it('rejects hostnames, public IPs and malformed literals', () => {
    for (const host of [
      '',
      'localhost',
      'metadata.google.internal',
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '999.1.1.1',
      '2001:db8::1',
      '::ffff:127.0.0.1'
    ]) {
      expect(isAllowedListenHost(host), host).toBe(false)
    }
  })

  it('validates every address in a multi-address listen list', () => {
    expect(isAllowedListenList('127.0.0.1,0.0.0.0')).toBe(true)
    expect(isAllowedListenList('127.0.0.1, metadata.google.internal')).toBe(false)
    expect(isAllowedListenList('')).toBe(false)
    expect(isAllowedListenList(' , ')).toBe(false)
  })
})

describe('assertSafeSettingsPatch — health/batch numeric bounds', () => {
  it('accepts valid values and rejects out-of-range/non-numeric ones', () => {
    expect(() =>
      assertSafeSettingsPatch({
        healthCheckIntervalMs: 5000,
        healthCheckTimeoutMs: 2000,
        healthStaleMs: 180000,
        autoRecoverCooldownMs: 300000,
        autoRecoverMaxAttempts: 3,
        batchDeadlineMs: 1800000,
        healthCheckEnabled: true,
        autoRecover: false
      })
    ).not.toThrow()
    for (const patch of [
      { healthCheckIntervalMs: 10 },
      { healthCheckTimeoutMs: 999999 },
      { healthStaleMs: 1 },
      { autoRecoverCooldownMs: 1 },
      { autoRecoverMaxAttempts: 0 },
      { batchDeadlineMs: 1 },
      { healthCheckEnabled: 'yes' },
      { autoRecover: 1 }
    ]) {
      expect(() => assertSafeSettingsPatch(patch as never)).toThrow()
    }
  })
})

describe('assertSafeSettingsPatch — aria2Path', () => {
  it('rejects relative and missing executables', () => {
    expect(() => assertSafeSettingsPatch({ aria2Path: 'aria2c' })).toThrow(/absolute/)
    expect(() => assertSafeSettingsPatch({ aria2Path: '/definitely/not/here/aria2c' })).toThrow(
      /existing file/
    )
  })

  it('accepts an empty value (reset to PATH lookup)', () => {
    expect(() => assertSafeSettingsPatch({ aria2Path: '' })).not.toThrow()
  })
})

describe('assertSafeSettingsPatch — activeInstance', () => {
  it('accepts a plain id / explicit empty and rejects injected lines', () => {
    expect(() => assertSafeSettingsPatch({ activeInstance: 'i-123_abc' })).not.toThrow()
    expect(() => assertSafeSettingsPatch({ activeInstance: '' })).not.toThrow()
    for (const bad of ['a\nb', 'a\rb', 'a\0b', 42, 'x'.repeat(201)]) {
      expect(() => assertSafeSettingsPatch({ activeInstance: bad as never })).toThrow()
    }
  })
})
