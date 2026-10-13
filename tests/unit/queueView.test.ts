/**
 * Queue view merge (0.1.11) — /queue running/pending + terminal /api/jobs,
 * de-duplicated by id (job id == prompt id on ComfyUI 0.39+).
 */
import { describe, it, expect } from 'vitest'
import { buildQueueSections } from '../../src/renderer/src/utils/queueView'

describe('buildQueueSections (0.1.11)', () => {
  it('merges queue and jobs without duplicating the in-progress task', () => {
    const sections = buildQueueSections(
      {
        running: [{ promptId: 'p-running', status: 'running' }],
        pending: [{ promptId: 'p-wait', status: 'pending' }],
        doneCount: 0,
        history: []
      },
      [
        // The SAME task /queue already shows as running — must NOT reappear in
        // the "recent" section as 「执行中」like the old side-by-side layout.
        { id: 'p-running', status: 'in_progress', createdAt: 1 },
        { id: 'p-done', status: 'completed', createdAt: 2 },
        { id: 'p-failed', status: 'failed', createdAt: 3 }
      ]
    )
    expect(sections.map((s) => s.key)).toEqual(['running', 'pending', 'recent'])
    expect(sections[0].items.map((i) => i.id)).toEqual(['p-running'])
    expect(sections[1].items.map((i) => i.id)).toEqual(['p-wait'])
    expect(sections[2].items.map((i) => i.id)).toEqual(['p-done', 'p-failed'])
    expect(sections[2].items[0].at).toBe(2)
  })

  it('drops pending jobs too and tolerates missing sources', () => {
    const onlyQueue = buildQueueSections(
      { running: [], pending: [{ promptId: 'x', status: 'pending' }], doneCount: 0, history: [] },
      [{ id: 'x', status: 'pending' }]
    )
    expect(onlyQueue).toHaveLength(1)
    expect(onlyQueue[0].key).toBe('pending')

    const onlyJobs = buildQueueSections(null, [{ id: 'j', status: 'cancelled' }])
    expect(onlyJobs).toHaveLength(1)
    expect(onlyJobs[0].key).toBe('recent')

    expect(buildQueueSections(null, null)).toEqual([])
    expect(
      buildQueueSections({ running: [], pending: [], doneCount: 0, history: [] }, null)
    ).toEqual([])
  })
})
