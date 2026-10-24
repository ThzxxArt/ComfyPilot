// @vitest-environment happy-dom
/**
 * 0.1.18 (WP8): the indeterminate bar must stay visibly "working" and must use
 * the app's primary colour (it previously referenced an undefined CSS variable
 * and silently fell back to Naive's green).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import IndeterminateBar from '../../../src/renderer/src/components/IndeterminateBar.vue'

describe('IndeterminateBar', () => {
  it('renders the animated segment at the requested height', () => {
    const w = mount(IndeterminateBar, { props: { height: 12 } })
    const track = w.find('.indet-track')
    expect(track.exists()).toBe(true)
    expect(track.attributes('style')).toContain('height: 12px')
    expect(w.find('.indet-seg').exists()).toBe(true)
  })

  it('shows the label only when provided', () => {
    const bare = mount(IndeterminateBar)
    expect(bare.find('.indet-label').exists()).toBe(false)
    bare.unmount()

    const labelled = mount(IndeterminateBar, { props: { label: 'Installing pip…' } })
    expect(labelled.find('.indet-label').text()).toBe('Installing pip…')
  })
})
