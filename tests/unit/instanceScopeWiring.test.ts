/**
 * 0.1.17 (WP9): the scope subscription wiring — every switch tick must run the
 * view's cleanup handler. Isolated in its own file so the store mock is the
 * only version of `@/stores/app` this module graph sees.
 */
import { describe, it, expect, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

const tick = ref(0)

vi.mock('@/stores/app', () => ({
  // A getter (not a snapshot) so the composable's watch actually tracks the ref.
  useAppStore: () => ({
    get instanceSwitchTick() {
      return tick.value
    }
  })
}))

describe('useInstanceScope wiring (WP9)', () => {
  it('calls the handler on every switch tick', async () => {
    const { useInstanceScope } = await import('../../src/renderer/src/composables/useInstanceScope')
    let calls = 0
    const scope = effectScope()
    scope.run(() => useInstanceScope(() => (calls += 1)))
    expect(calls).toBe(0)

    tick.value += 1
    await nextTick()
    expect(calls).toBe(1)

    tick.value += 1
    await nextTick()
    expect(calls).toBe(2)

    scope.stop()
    tick.value += 1
    await nextTick()
    // A stopped scope must not keep firing view callbacks.
    expect(calls).toBe(2)
  })
})
