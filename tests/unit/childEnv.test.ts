import { describe, it, expect } from 'vitest'
import { comfyChildEnv, PYTHON_UTF8_ENV } from '../../src/main/services/childEnv'
import type { ProxySettings } from '../../src/shared/types'

const off: ProxySettings = {
  enabled: false,
  protocol: 'http',
  host: '',
  port: 0,
  username: '',
  password: '',
  bypass: ''
}
const on: ProxySettings = {
  enabled: true,
  protocol: 'http',
  host: '127.0.0.1',
  port: 7897,
  username: '',
  password: '',
  bypass: 'localhost,127.0.0.1,::1'
}

describe('comfyChildEnv (0.1.16)', () => {
  it('always sets UTF-8 + unbuffered (fixes the GBK pip-build failure)', () => {
    const env = comfyChildEnv({ proxy: off }, {})
    expect(env.PYTHONUTF8).toBe('1')
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.PYTHONUNBUFFERED).toBe('1')
    expect(PYTHON_UTF8_ENV.PYTHONUTF8).toBe('1')
  })

  it('strips stale proxy vars when the app proxy is disabled', () => {
    const env = comfyChildEnv(
      { proxy: off },
      { ...process.env, HTTP_PROXY: 'http://x', NO_PROXY: 'stale' }
    )
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.NO_PROXY).toBeUndefined()
  })

  it('injects the app proxy with a bracket-free no_proxy when enabled', () => {
    const env = comfyChildEnv({ proxy: on }, {})
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.NO_PROXY).toContain('::1')
    expect(env.NO_PROXY).not.toContain('[::1]')
  })
})
