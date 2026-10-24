/**
 * 0.1.18 (regression): importing a settings file used to set `proxy.password`
 * to '' — which looked like "no change" but flowed through saveSettings and
 * ERASED the stored password. The helper removes the key entirely.
 */
import { describe, it, expect } from 'vitest'
import {
  stripImportedSettingsSecrets,
  assertSafeSettingsPatch
} from '../../src/main/services/security'

describe('stripImportedSettingsSecrets', () => {
  it('removes the proxy password key instead of blanking it', () => {
    const { patch, applied } = stripImportedSettingsSecrets({
      locale: 'zh-CN',
      proxy: { enabled: true, host: '127.0.0.1', port: 7890, password: 'leaked' }
    })
    const proxy = patch.proxy as Record<string, unknown>
    expect('password' in proxy).toBe(false)
    expect(proxy.host).toBe('127.0.0.1')
    expect(proxy.port).toBe(7890)
    expect(patch.locale).toBe('zh-CN')
    expect(applied).toContain('proxy')
  })

  it('never imports the runtime-integrity escape hatch', () => {
    const { patch } = stripImportedSettingsSecrets({
      allowUnverifiedRuntime: true,
      locale: 'en-US'
    })
    expect('allowUnverifiedRuntime' in patch).toBe(false)
    expect(patch.locale).toBe('en-US')
  })

  it('leaves an imported patch valid for the normal settings validator', () => {
    const { patch } = stripImportedSettingsSecrets({
      securityLevel: 'strong',
      proxy: { enabled: false, host: '', port: 7890, password: 'x' }
    })
    expect(() => assertSafeSettingsPatch(patch)).not.toThrow()
  })

  it('tolerates a settings file without a proxy section', () => {
    const { patch } = stripImportedSettingsSecrets({ locale: 'zh-CN' })
    expect(patch.locale).toBe('zh-CN')
    expect(patch.proxy).toBeUndefined()
  })
})
