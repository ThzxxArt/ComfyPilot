import { describe, it, expect } from 'vitest'
import { LAUNCH_TEMPLATES, DEFAULT_SETTINGS, MODEL_CATEGORY_LABELS } from '../../src/shared/constants'
import { IPC_EVENTS } from '../../src/shared/types'

describe('shared constants', () => {
  it('has launch templates covering manager / offline / lan', () => {
    const ids = LAUNCH_TEMPLATES.map((t) => t.id)
    expect(ids).toContain('manager')
    expect(ids).toContain('offline')
    expect(ids).toContain('lan')
    expect(ids).toContain('preview-taesd')
    expect(ids).toContain('lowvram')
  })

  it('defaults to light theme and locked-down security', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('light')
    expect(DEFAULT_SETTINGS.securityLevel).toBe('normal')
    expect(DEFAULT_SETTINGS.allowGitUrlInstall).toBe(false)
    expect(DEFAULT_SETTINGS.allowPipInstall).toBe(true)
    expect(DEFAULT_SETTINGS.embedFrontend).toBe(true)
    expect(DEFAULT_SETTINGS.networkMode).toBe('public')
  })

  it('covers core model categories', () => {
    for (const key of ['checkpoints', 'loras', 'vae', 'controlnet', 'diffusion_models']) {
      expect(MODEL_CATEGORY_LABELS[key]).toBeTruthy()
    }
  })
})

describe('IPC events', () => {
  it('exposes live event channels used by the plan', () => {
    expect(IPC_EVENTS.instanceStatus).toBe('event:instance-status')
    expect(IPC_EVENTS.monitorWs).toBe('event:monitor-ws')
    expect(IPC_EVENTS.batchProgress).toBe('event:batch-progress')
    expect(IPC_EVENTS.downloadProgress).toBe('event:download-progress')
    expect(IPC_EVENTS.modelScanProgress).toBe('event:model-scan-progress')
  })
})
