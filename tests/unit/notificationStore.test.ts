/**
 * 0.1.18 (WP8): behaviour test extracted from the deleted source-text contract
 * file. The notification bus must keep a monotonic sequence while the retained
 * history is bounded — watching array length alone loses events after the cap.
 */
import { describe, it, expect } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

describe('app store notifications', () => {
  it('keeps a monotonic seq and bounds history', async () => {
    setActivePinia(createPinia())
    const { useAppStore } = await import('../../src/renderer/src/stores/app')
    const store = useAppStore()
    for (let i = 0; i < 250; i++) {
      store.pushNotification({ type: 'info', title: `n${i}`, message: '' })
    }
    expect(store.notificationSeq).toBe(250)
    expect(store.notifications.length).toBe(200)
    expect(store.notifications.at(-1)?.title).toBe('n249')
    expect(store.notifications[0]?.title).toBe('n50')
  })

  it('queues only new notices, dedupes a burst and tracks unread', async () => {
    setActivePinia(createPinia())
    const { useAppStore } = await import('../../src/renderer/src/stores/app')
    const store = useAppStore()
    for (let i = 0; i < 50; i++) {
      store.pushNotification({ type: 'info', title: `h${i}`, message: '' })
    }
    for (const n of [...store.toastQueue]) store.consumeToast(n.id)
    expect(store.toastQueue).toHaveLength(0)
    expect(store.unreadCount).toBe(50)

    store.pushNotification({ type: 'success', title: 'new', message: '', dedupeKey: 'batch' })
    store.pushNotification({ type: 'success', title: 'new again', message: '', dedupeKey: 'batch' })
    expect(store.toastQueue).toHaveLength(1)
    expect(store.notifications.length).toBe(51)

    store.markAllRead()
    expect(store.unreadCount).toBe(0)
  })
})
