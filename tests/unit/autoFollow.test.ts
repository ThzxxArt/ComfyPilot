/**
 * Terminal log auto-follow (0.1.11) — pure predicate + handle behaviour over
 * a fake scroll element (no DOM needed).
 */
import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import {
  isPinnedToBottom,
  useAutoFollow,
  AUTO_FOLLOW_THRESHOLD
} from '../../src/renderer/src/composables/useAutoFollow'

type FakeEl = { scrollHeight: number; scrollTop: number; clientHeight: number }

describe('isPinnedToBottom (0.1.11)', () => {
  it('counts the bottom band as pinned', () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true)
    expect(
      isPinnedToBottom({
        scrollHeight: 1000,
        scrollTop: 800 - AUTO_FOLLOW_THRESHOLD,
        clientHeight: 200
      })
    ).toBe(true)
  })

  it('detaches once the user scrolls up', () => {
    expect(
      isPinnedToBottom({
        scrollHeight: 1000,
        scrollTop: 800 - AUTO_FOLLOW_THRESHOLD - 1,
        clientHeight: 200
      })
    ).toBe(false)
    expect(isPinnedToBottom({ scrollHeight: 2000, scrollTop: 0, clientHeight: 200 })).toBe(false)
  })
})

describe('useAutoFollow handle (0.1.11)', () => {
  it('follows by default, pauses on scroll-up, and jumps back on demand', async () => {
    const handle = useAutoFollow()
    const el: FakeEl = { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 }
    handle.el.value = el as unknown as HTMLElement

    expect(handle.follow.value).toBe(true)
    expect(handle.showJump.value).toBe(false)

    // Content grows while pinned → next tick snaps to the bottom.
    el.scrollHeight = 1200
    handle.requestScroll()
    await nextTick()
    expect(el.scrollTop).toBe(1200)

    // User scrolls up → follow pauses + jump affordance shows.
    el.scrollTop = 100
    handle.onScroll()
    expect(handle.follow.value).toBe(false)
    expect(handle.showJump.value).toBe(true)

    // New content while paused must NOT yank the viewport.
    const before = el.scrollTop
    el.scrollHeight = 1400
    handle.requestScroll()
    await nextTick()
    expect(el.scrollTop).toBe(before)

    // Explicit jump resumes following.
    handle.jumpToBottom()
    await nextTick()
    expect(el.scrollTop).toBe(1400)
    expect(handle.follow.value).toBe(true)
    expect(handle.showJump.value).toBe(false)
  })
})
