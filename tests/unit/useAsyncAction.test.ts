import { describe, expect, it } from 'vitest'
import { useAsyncAction } from '../../src/renderer/src/composables/useAsyncAction'

describe('useAsyncAction (0.2.0)', () => {
  it('runs one action at a time and exposes errors', async () => {
    const action = useAsyncAction()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const first = action.run('save', async () => {
      await gate
      return 'ok'
    })
    expect(action.busy.value).toBe('save')
    // A second click is ignored while the first is in flight.
    expect(await action.run('delete', async () => 'no')).toBeUndefined()
    release()
    expect(await first).toBe('ok')
    expect(action.busy.value).toBe('')

    expect(
      await action.run('fail', async () => {
        throw new Error('nope')
      })
    ).toBeUndefined()
    expect(action.error.value).toBe('nope')
  })
})
