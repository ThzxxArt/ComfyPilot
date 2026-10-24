/**
 * 0.1.18 regression: the settings validator must cover every field that is
 * later interpolated into a URL (proxy.protocol) or executed (aria2Path).
 */
import { describe, it, expect } from 'vitest'
import { assertSafeSettingsPatch } from '../../src/main/services/security'

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
