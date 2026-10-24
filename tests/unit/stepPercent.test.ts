/**
 * 0.1.18 (WP5/WP8): the one honest progress rule.
 *
 * Three modals used to treat a real 0% as "unknown" (`!step.progress`), and the
 * node-op modal could show a determinate bar for a step with no denominator.
 * This is the pure function they now share.
 */
import { describe, it, expect } from 'vitest'
import { stepPercent } from '../../src/renderer/src/utils/progress'
import type { UpdateStep } from '../../src/shared/types'

function step(over: Partial<UpdateStep> = {}): UpdateStep {
  return {
    id: 'fetch',
    title: 'Fetch',
    status: 'running',
    detail: '',
    log: [],
    ...over
  }
}

describe('stepPercent', () => {
  it('treats a real 0 as a real value, not "indeterminate"', () => {
    expect(stepPercent(step({ progress: 0 }))).toBe(0)
    expect(stepPercent(step({ workDone: 0, workTotal: 200 }))).toBe(0)
  })

  it('computes a percentage from a 0..1 fraction', () => {
    expect(stepPercent(step({ progress: 0.5 }))).toBe(50)
    expect(stepPercent(step({ progress: 0.999 }))).toBe(100)
  })

  it('prefers item counts over the legacy fraction', () => {
    expect(stepPercent(step({ progress: 0.1, workDone: 50, workTotal: 200 }))).toBe(25)
  })

  it('is indeterminate only without any measurement', () => {
    expect(stepPercent(step())).toBeNull()
    expect(stepPercent(step({ workTotal: 0 }))).toBeNull()
    expect(stepPercent(null)).toBeNull()
  })

  it('ignores steps that are not running', () => {
    expect(stepPercent(step({ status: 'done', progress: 0.5 }))).toBeNull()
    expect(stepPercent(step({ status: 'pending' }))).toBeNull()
  })

  it('clamps out-of-range values', () => {
    expect(stepPercent(step({ progress: 2 }))).toBe(100)
    expect(stepPercent(step({ progress: -1 }))).toBe(0)
  })
})
