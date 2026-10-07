import { describe, expect, it } from 'vitest'
import { toPlainIpcArg } from '../../src/renderer/src/composables/useIpc'

describe('toPlainIpcArg — Electron IPC structured-clone safety', () => {
  it('passes primitives through unchanged', () => {
    expect(toPlainIpcArg('x')).toBe('x')
    expect(toPlainIpcArg(1)).toBe(1)
    expect(toPlainIpcArg(true)).toBe(true)
    expect(toPlainIpcArg(null)).toBe(null)
    expect(toPlainIpcArg(undefined)).toBe(undefined)
  })

  it('unwraps nested reactive-style Proxy objects (Vue ref payloads)', () => {
    const raw = {
      theme: 'light',
      proxy: { enabled: true, host: '127.0.0.1', port: 7897, bypass: 'localhost' },
      modelScanRoots: ['D:/models']
    }
    const reactive = new Proxy(raw, {
      get(target, prop, receiver) {
        return Reflect.get(target, prop, receiver)
      }
    })
    const out = toPlainIpcArg(reactive)
    expect(out).toEqual(raw)
    // Must be a plain object — no Proxy
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(JSON.stringify(out)).toBe(JSON.stringify(raw))
  })

  it('strips functions and class instances to plain data', () => {
    class Foo {
      x = 1
      fn = (): number => 2
    }
    const out = toPlainIpcArg({ a: new Foo(), b: 2 })
    expect(out).toEqual({ a: { x: 1 }, b: 2 })
  })

  it('matches the proxy.test result shape used by SettingsView', () => {
    const result = { ok: true, via: 'http://127.0.0.1:7897', ms: 12 }
    expect(toPlainIpcArg(result)).toEqual(result)
  })
})
