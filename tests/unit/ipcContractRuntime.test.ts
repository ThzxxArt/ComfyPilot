import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '@shared/types'
import {
  channelSchemaCount,
  hasSchema,
  instrumentIpcContract,
  validateIpcArgs
} from '../../src/main/ipc/contract'

describe('runtime IPC contract (0.2.0)', () => {
  it('has an explicit schema entry for every channel', () => {
    for (const channel of IPC_CHANNELS) expect(hasSchema(channel)).toBe(true)
    expect(channelSchemaCount()).toBe(IPC_CHANNELS.length)
  })

  it('rejects wrong primitive/object shapes on high-risk channels', () => {
    expect(() => validateIpcArgs('settings.set', [{ locale: 'en-US' }])).not.toThrow()
    expect(() => validateIpcArgs('settings.set', ['not-an-object'])).toThrow(/IPC|Invalid/i)
    expect(() => validateIpcArgs('instance.save', [{ id: 'i1' }])).not.toThrow()
    expect(() => validateIpcArgs('instance.save', [])).toThrow(/Invalid IPC arguments/i)
    expect(() => validateIpcArgs('instance.migratePython', ['i1'])).not.toThrow()
    expect(() => validateIpcArgs('instance.migratePython', [42])).toThrow(/Invalid IPC arguments/i)
    expect(() => validateIpcArgs('node.installDeps', ['p1', 'i1', ['a>=1']])).not.toThrow()
    expect(() => validateIpcArgs('node.installDeps', ['p1', 'i1', [1]])).toThrow(
      /Invalid IPC arguments/i
    )
  })

  it('rejects an unknown channel', () => {
    expect(() => validateIpcArgs('not.a.channel', [])).toThrow(/Unknown IPC channel/i)
  })

  it('wraps ipcMain.handle once and blocks untrusted sender frames', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ipc = {
      handle: (channel: string, fn: (...args: never[]) => unknown) => {
        handlers.set(channel, fn as unknown as (...args: unknown[]) => unknown)
      }
    }
    expect(instrumentIpcContract(ipc)).toBe(true)
    expect(instrumentIpcContract(ipc)).toBe(false)
    ipc.handle('settings.get', () => 'ok')
    const blocked = (await handlers.get('settings.get')!({
      senderFrame: { url: 'https://evil.example' }
    })) as { ok: boolean; code?: string }
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('IPC_UNTRUSTED_FRAME')
    // No senderFrame (unit test / direct call) is allowed.
    expect(await handlers.get('settings.get')!({})).toBe('ok')
  })
})
