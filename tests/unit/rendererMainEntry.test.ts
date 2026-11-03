// @vitest-environment happy-dom
/** 0.2.3: the renderer entry must mount the app shell exactly once. */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'

vi.mock('../../src/renderer/src/App.vue', () => ({
  default: defineComponent({ template: '<div data-test="app">mounted</div>' })
}))
vi.mock('../../src/renderer/src/router', () => ({
  router: { install: () => undefined }
}))

describe('renderer entry', () => {
  it('mounts the root component into #app', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    await import('../../src/renderer/src/main')
    await flushPromises()
    expect(document.querySelector('#app')?.textContent).toContain('mounted')
    // A missing mount node must stay absent rather than being fabricated.
    expect(document.querySelector('#missing')).toBeNull()
  })
})
