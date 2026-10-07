/**
 * Regression locks for 0.1.3 review findings.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: () => path.join(os.tmpdir(), 'cp-reg-fix-test'),
      getAppPath: () => path.join(os.tmpdir(), 'cp-reg-fix-test'),
      isPackaged: false
    },
    session: { defaultSession: { fetch: globalThis.fetch, setProxy: async () => undefined } },
    dialog: { showSaveDialog: async () => ({ canceled: true }) }
  }
})
vi.mock('systeminformation', () => ({
  default: { graphics: async () => ({ controllers: [] }) }
}))

describe('launch script escaping (command-injection regression)', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('bat escaping neutralizes quotes, % and cmd metacharacters', async () => {
    const { escapeForBat } = await import('../../src/main/services/instance')
    const evil = 'C:\\foo%COMSPEC:~0,0%&calc&'
    const quoted = escapeForBat(evil)
    // % doubled, & escaped with ^, always wrapped in quotes
    expect(quoted.startsWith('"') && quoted.endsWith('"')).toBe(true)
    expect(quoted).toContain('%%')
    expect(quoted).toContain('^&')
    expect(escapeForBat('say "hi"')).toContain('""')
  })

  it('sh escaping uses single quotes and neutralizes $() backticks', async () => {
    const { escapeForSh } = await import('../../src/main/services/instance')
    const q = escapeForSh('$(calc)')
    expect(q).toBe("'$(calc)'")
    expect(escapeForSh("it's")).toBe("'it'\\''s'")
  })
})

describe('resolveTorchIndex mirror layout', () => {
  beforeAll(() => {
    vi.resetModules()
  })

  it('wheel-style mirror becomes <prefix>/<channel>', async () => {
    const { resolveTorchIndex } = await import('../../src/main/services/installer')
    const { loadSettings, saveSettings, DEFAULT_SETTINGS } = await import('../../src/shared/constants').then(
      async (m) => {
        const db = await import('../../src/main/services/db')
        return { loadSettings: db.loadSettings, saveSettings: db.saveSettings, DEFAULT_SETTINGS: m.DEFAULT_SETTINGS }
      }
    )
    void loadSettings
    saveSettings({ torchIndexMirror: 'https://mirror.sjtu.edu.cn/pytorch-wheels' })
    // PEP 503 simple index requires a trailing slash
    expect(resolveTorchIndex('cu130')).toBe('https://mirror.sjtu.edu.cn/pytorch-wheels/cu130/')
    saveSettings({ torchIndexMirror: '' })
    expect(resolveTorchIndex('cpu')).toContain('download.pytorch.org')
    void DEFAULT_SETTINGS
    void saveSettings
  })
})
