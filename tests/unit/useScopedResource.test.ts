import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useScopedResource } from '../../src/renderer/src/composables/useScopedResource'

describe('useScopedResource (0.2.0)', () => {
  it('discards a response from a scope that is no longer current', async () => {
    const scope = ref<string | null>('a')
    const gateControl: { resolve?: (v: string) => void } = {}
    const gate = new Promise<string>((r) => {
      gateControl.resolve = r
    })
    const seen: string[] = []
    const effect = effectScope()
    const resource = effect.run(() =>
      useScopedResource(async (id) => {
        seen.push(id)
        if (id === 'a') return gate
        return `b-result`
      }, scope)
    )!
    await nextTick()
    // Switch while A is still in flight.
    scope.value = 'b'
    await nextTick()
    await Promise.resolve()
    gateControl.resolve?.('a-result')
    await gate
    await Promise.resolve()
    await nextTick()
    expect(resource.data.value).toBe('b-result')
    expect(seen).toEqual(['a', 'b'])
    effect.stop()
  })

  it('clears data when the scope becomes empty', async () => {
    const scope = ref<string | null>('a')
    const effect = effectScope()
    const resource = effect.run(() => useScopedResource(async () => 'a-result', scope))!
    await nextTick()
    await Promise.resolve()
    await nextTick()
    expect(resource.data.value).toBe('a-result')
    scope.value = null
    await nextTick()
    expect(resource.data.value).toBeNull()
    effect.stop()
  })
})
