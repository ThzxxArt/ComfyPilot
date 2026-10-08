/**
 * Install-run persistence (0.1.4): progress survives an app restart so the
 * install wizard can restore the latest run after relaunch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/fake/userData'),
    getName: vi.fn(() => 'ComfyPilot'),
    getVersion: vi.fn(() => '0.1.4')
  },
  session: { defaultSession: { fetch: vi.fn(), setProxy: vi.fn() } }
}))

import {
  saveInstallRun,
  loadInstallRuns,
  loadLatestInstallRun,
  clearInstallRuns
} from '../../src/main/services/db'

describe('install-run persistence', () => {
  beforeEach(() => {
    clearInstallRuns()
  })

  it('returns null when nothing has been persisted', () => {
    expect(loadLatestInstallRun()).toBeNull()
    expect(loadInstallRuns()).toEqual([])
  })

  it('persists a run and restores it', () => {
    const run = {
      runId: 'run-1',
      status: 'running',
      step: 'venv',
      percent: 40,
      message: 'Creating venv',
      steps: [{ id: 'venv', title: 'Create venv', status: 'running', detail: '', log: [] }]
    }
    saveInstallRun(run)
    const restored = loadLatestInstallRun()
    expect(restored).not.toBeNull()
    expect(restored?.runId).toBe('run-1')
    expect(restored?.status).toBe('running')
    expect(restored?.percent).toBe(40)
  })

  it('updates an existing run in place instead of duplicating', () => {
    saveInstallRun({ runId: 'run-1', status: 'running', percent: 10 })
    saveInstallRun({ runId: 'run-1', status: 'done', percent: 100 })
    const runs = loadInstallRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('done')
  })

  it('prefers an in-flight run over a finished one', () => {
    saveInstallRun({ runId: 'old', status: 'done', percent: 100 })
    saveInstallRun({ runId: 'live', status: 'running', percent: 50 })
    const latest = loadLatestInstallRun()
    expect(latest?.runId).toBe('live')
  })

  it('falls back to the newest finished run when nothing is running', () => {
    saveInstallRun({ runId: 'a', status: 'done', percent: 100 })
    saveInstallRun({ runId: 'b', status: 'failed', percent: 60 })
    const latest = loadLatestInstallRun()
    // unshift puts newest first
    expect(latest?.runId).toBe('b')
  })

  it('caps history at 20 runs', () => {
    for (let i = 0; i < 30; i++) {
      saveInstallRun({ runId: `run-${i}`, status: 'done', percent: 100 })
    }
    expect(loadInstallRuns()).toHaveLength(20)
    // newest kept
    expect(loadInstallRuns()[0].runId).toBe('run-29')
  })

  it('clearInstallRuns empties the store', () => {
    saveInstallRun({ runId: 'x', status: 'done' })
    clearInstallRuns()
    expect(loadInstallRuns()).toEqual([])
    expect(loadLatestInstallRun()).toBeNull()
  })
})
