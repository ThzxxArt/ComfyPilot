import { describe, expect, it } from 'vitest'
import { credentialOriginForUrl, proxyCredentialOrigin } from '../../src/main/services/security'

describe('credential endpoint binding (0.2.0)', () => {
  it('normalizes URL origins including the path', () => {
    expect(credentialOriginForUrl('HTTP://Example.COM:8188/prod/')).toBe(
      'http://example.com:8188/prod'
    )
    expect(credentialOriginForUrl('http://example.com:8188/dev')).not.toBe(
      credentialOriginForUrl('http://example.com:8188/prod')
    )
  })

  it('changes the proxy origin when protocol/host/port/username changes', () => {
    const base = { protocol: 'http', host: '127.0.0.1', port: 7890, username: 'u' }
    expect(proxyCredentialOrigin(base)).toBe('http://u@127.0.0.1:7890')
    expect(proxyCredentialOrigin({ ...base, host: 'evil' })).not.toBe(proxyCredentialOrigin(base))
    expect(proxyCredentialOrigin({ ...base, username: 'other' })).not.toBe(
      proxyCredentialOrigin(base)
    )
  })

  it('returns an empty origin for malformed URLs', () => {
    expect(credentialOriginForUrl('not a url')).toBe('')
  })
})
