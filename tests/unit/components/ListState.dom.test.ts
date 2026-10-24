// @vitest-environment happy-dom
/**
 * 0.1.18 (WP8): the first real component tests.
 *
 * `ListState` is the three-state primitive every list now uses; a regression
 * here silently turns "load failed" back into "you have no data" across the app.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ListState from '../../../src/renderer/src/components/ListState.vue'
import zhCN from '../../../src/renderer/src/i18n/locales/zh-CN'
import enUS from '../../../src/renderer/src/i18n/locales/en-US'

function i18n(): ReturnType<typeof createI18n> {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': zhCN, 'en-US': enUS }
  })
}

function mountState(props: Record<string, unknown>, slot = '<div class="content">rows</div>') {
  return mount(ListState, {
    props,
    slots: { default: slot },
    global: { plugins: [i18n()] }
  })
}

describe('ListState', () => {
  it('renders skeletons while loading and never the empty state', () => {
    const w = mountState({ loading: true, rows: 3 })
    expect(w.find('[data-state="loading"]').exists()).toBe(true)
    expect(w.find('[data-state="empty"]').exists()).toBe(false)
    expect(w.text()).not.toContain('暂无数据')
  })

  it('renders an error with the real message and emits retry', async () => {
    const w = mountState({ error: 'ECONNREFUSED 127.0.0.1:8188' })
    expect(w.find('[data-state="error"]').exists()).toBe(true)
    expect(w.text()).toContain('ECONNREFUSED')
    await w.find('button').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('distinguishes "no data" from "filters matched nothing"', () => {
    const empty = mountState({ empty: true })
    expect(empty.find('[data-state="empty"]').exists()).toBe(true)
    expect(empty.text()).toContain('暂无数据')
    empty.unmount()

    const filtered = mountState({ empty: true, filtered: true })
    expect(filtered.text()).toContain('没有匹配项')
  })

  it('renders the slot when data is present', () => {
    const w = mountState({})
    expect(w.find('.content').exists()).toBe(true)
    expect(w.find('[data-state]').exists()).toBe(false)
  })
})
