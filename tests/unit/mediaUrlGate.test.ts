import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: { getPath: () => path.join(os.tmpdir(), 'cp-media-test') },
    session: { defaultSession: { setProxy: async () => undefined } }
  }
})

describe('media Aria2Service download gate', () => {
  it('rejects non-http(s) URLs before invoking aria2c', async () => {
    const { aria2Service } = await import('../../src/main/services/media')
    const bad = await aria2Service.download('file:///etc/passwd', '/tmp/x/a.bin')
    expect(bad.ok).toBe(false)
    expect(bad.log).toMatch(/Blocked URL scheme/i)
    const bad2 = await aria2Service.download('magnet:?xt=urn:btih:abc', '/tmp/x/a.bin')
    expect(bad2.ok).toBe(false)
    const bad3 = await aria2Service.download('ftp://host/a.bin', '/tmp/x/a.bin')
    expect(bad3.ok).toBe(false)
  })
})
