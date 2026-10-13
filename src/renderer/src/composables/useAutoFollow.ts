/**
 * Terminal-style auto-follow (0.1.11).
 *
 * The log pane sticks to the bottom while the user is already there (or after
 * an explicit jump); scrolling up detaches it so reading history is not
 * yanked away by new lines. The logic is DOM-light on purpose — tests drive it
 * with a fake scroll element.
 */
import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'

/** Distance (px) from the bottom that still counts as "pinned". */
export const AUTO_FOLLOW_THRESHOLD = 24

export interface AutoFollowHandle {
  /** Bind with `ref="logBox"` on the scroll container. */
  el: Ref<HTMLElement | null>
  /** True while new content should snap the box to the bottom. */
  follow: Ref<boolean>
  /** True when the "back to bottom" affordance should be visible. */
  showJump: ComputedRef<boolean>
  /** Container `@scroll` handler. */
  onScroll: () => void
  /** Call after content grew; scrolls only while following. */
  requestScroll: () => void
  /** Force-resume following and jump to the bottom. */
  jumpToBottom: () => void
}

type ScrollMetrics = { scrollHeight: number; scrollTop: number; clientHeight: number }

/** Pure predicate — exported so the behaviour is unit-testable. */
export function isPinnedToBottom(m: ScrollMetrics, threshold = AUTO_FOLLOW_THRESHOLD): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold
}

export function useAutoFollow(): AutoFollowHandle {
  const el = ref<HTMLElement | null>(null)
  const follow = ref(true)
  const showJump = computed(() => !follow.value)

  function onScroll(): void {
    const node = el.value
    if (!node) return
    follow.value = isPinnedToBottom(node)
  }

  /** Jump the container to its end; retries once after paint when the pane is
   *  still hidden (v-show panes report clientHeight 0 and cannot scroll yet). */
  function scrollToEnd(): void {
    void nextTick(() => {
      const node = el.value
      if (!node) return
      if (node.clientHeight === 0 && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          const retried = el.value
          if (retried) retried.scrollTop = retried.scrollHeight
        })
        return
      }
      node.scrollTop = node.scrollHeight
    })
  }

  function requestScroll(): void {
    if (!follow.value) return
    scrollToEnd()
  }

  function jumpToBottom(): void {
    follow.value = true
    scrollToEnd()
  }

  return { el, follow, showJump, onScroll, requestScroll, jumpToBottom }
}
