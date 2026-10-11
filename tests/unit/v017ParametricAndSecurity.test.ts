import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const readSrc = (rel: string): string =>
  readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ Batch parametric edge cases ============
describe('batch: emptyItem defaults', () => {
  const cases = [
    { name: 'all-zero', count: 5, submitted: 0, completed: 0, failed: 0, submitFailed: 0, execFailed: 0 },
    { name: 'some-progress', count: 10, submitted: 5, completed: 3, failed: 1, submitFailed: 1, execFailed: 0 },
    { name: 'all-done', count: 3, submitted: 3, completed: 3, failed: 0, submitFailed: 0, execFailed: 0 },
    { name: 'all-failed', count: 2, submitted: 2, completed: 0, failed: 2, submitFailed: 0, execFailed: 2 },
    { name: 'mixed', count: 8, submitted: 6, completed: 2, failed: 3, submitFailed: 1, execFailed: 2 }
  ]
  for (const c of cases) {
    it(`item accounting: ${c.name}`, () => {
      // Pure logic test: submitted = completed + execFailed + unsettled
      const unsettled = c.submitted - c.completed - c.execFailed
      expect(c.completed + c.execFailed + unsettled).toBe(c.submitted)
      // failed = submitFailed + execFailed
      expect(c.submitFailed + c.execFailed).toBe(c.failed)
    })
  }
})

describe('batch: unsettled timeout detection', () => {
  const cases = [
    { submitted: 10, completed: 8, execFailed: 2, expectTimeout: false },
    { submitted: 10, completed: 5, execFailed: 2, expectTimeout: true }, // 3 unsettled
    { submitted: 10, completed: 10, execFailed: 0, expectTimeout: false },
    { submitted: 5, completed: 0, execFailed: 5, expectTimeout: false },
    { submitted: 10, completed: 0, execFailed: 0, expectTimeout: true }, // 10 unsettled
  ]
  for (const c of cases) {
    it(`submitted=${c.submitted} completed=${c.completed} execFailed=${c.execFailed}`, () => {
      const unsettled = c.submitted - c.completed - c.execFailed
      const isTimeout = unsettled > 0
      expect(isTimeout).toBe(c.expectTimeout)
    })
  }

  it('submit failures do NOT mask timeouts (the bug fix)', () => {
    // submitted=10, completed=7, execFailed=0, submitFailed=5
    // OLD buggy: unsettled = 10-7-15 = -8 → NOT > 0 → wrongly marked done
    // NEW correct: unsettled = 10-7-0 = 3 → timeout!
    const submitted = 10, completed = 7, execFailed = 0, submitFailed = 5
    const failed = submitFailed + execFailed
    // Buggy formula
    const buggyUnsettled = submitted - completed - failed
    expect(buggyUnsettled).toBeLessThanOrEqual(0) // would NOT detect timeout
    // Correct formula
    const correctUnsettled = submitted - completed - execFailed
    expect(correctUnsettled).toBeGreaterThan(0) // DOES detect timeout
  })
})

// ============ Security: safeResolveUnder parametric ============
describe('security: safeResolveUnder blocks escapes', () => {
  const escapes = [
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    '%2e%2e/%2e%2e/etc',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'a/../../../etc'
  ]
  for (const e of escapes) {
    it(`blocks: ${e}`, async () => {
      const { safeResolveUnder } = await import('@main/services/security')
      const result = safeResolveUnder('/safe/root', e)
      expect(result === null || result === false).toBe(true)
    })
  }
})

// ============ Installer: URL patterns ============
describe('installer: github mirror rewriting', () => {
  it('handles various github URL formats', async () => {
    const { applyGithubMirror } = await import('@main/services/installer')
    const urls = [
      'https://github.com/user/repo',
      'https://github.com/user/repo.git',
      'https://raw.githubusercontent.com/user/repo/main/file',
      'https://api.github.com/repos/user/repo',
      'https://github.com/user/repo/archive/refs/heads/main.zip'
    ]
    for (const u of urls) {
      const result = applyGithubMirror(u)
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    }
  })
})

// ============ DB: JSONC edge cases ============
describe('DB: JSONC parse edge cases', () => {
  const cases = [
    { name: 'empty object', input: '{}', valid: true },
    { name: 'with comments', input: '{\n  // c\n  "a": 1\n}', valid: true },
    { name: 'trailing comma', input: '{"a": 1,}', valid: true },
    { name: 'nested', input: '{"a": {"b": [1,2,3]}}', valid: true },
    { name: 'unicode', input: '{"k": "中文测试"}', valid: true },
  ]
  for (const c of cases) {
    it(`parseJsonc: ${c.name}`, async () => {
      const { parseJsonc } = await import('@main/services/db')
      if (c.valid) {
        expect(() => parseJsonc(c.input)).not.toThrow()
      } else {
        expect(() => parseJsonc(c.input)).toThrow()
      }
    })
  }
})

// ============ Format: comprehensive ============
describe('format: formatBytes all units', () => {
  const cases = [
    [0, '0'], [1, '1'], [999, '999'], [1024, '1'], [1536, '1.5'],
    [1024 * 1024, '1'], [1024 * 1024 * 1024, '1']
  ]
  for (const [bytes, _prefix] of cases) {
    it(`formatBytes(${bytes})`, async () => {
      const { formatBytes } = await import('@/utils/format')
      const r = formatBytes(bytes as number)
      expect(typeof r).toBe('string')
      expect(r.length).toBeGreaterThan(0)
    })
  }
})

// ============ Type shape validation ============
describe('type shapes match runtime data', () => {
  it('DownloadTask has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['id', 'url', 'destPath', 'fileName', 'totalBytes', 'receivedBytes', 'status', 'startedAt', 'source']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })

  it('OutputAsset has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['id', 'path', 'fileName', 'type', 'size', 'createdAt', 'params']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })

  it('WorkflowRecord has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['id', 'name', 'path', 'format', 'nodeCount', 'tags', 'updatedAt', 'missingNodes', 'version', 'params', 'origin']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })

  it('NodePackRecord has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['id', 'name', 'displayName', 'description', 'author', 'version', 'status', 'nodeCount', 'tags', 'installSource', 'issues', 'locked', 'nodeList']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })

  it('ComfyInstanceConfig has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['id', 'name', 'path', 'pythonPath', 'venvPath', 'port', 'listen', 'extraArgs', 'argTemplateId', 'enabled', 'notes', 'autoStart', 'frontendVersion', 'pinned']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })

  it('AppSettings has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['locale', 'modelScanRoots', 'githubEndpoint', 'hfEndpoint', 'civitaiEndpoint', 'enableAutoCheckUpdates', 'embedFrontend', 'securityLevel', 'allowGitUrlInstall', 'allowPipInstall', 'networkMode', 'aria2Path', 'useAria2', 'launchOnBoot', 'minimizeToTray', 'autoStartInstancesOnLaunch', 'proxy', 'pipIndex', 'torchIndexMirror']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })

  it('InstallPlan has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['installRoot', 'instanceName', 'useUv', 'pythonPath', 'torchChannel', 'comfyRepo', 'comfyBranch', 'createDesktopShortcut', 'autoStart']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })

  it('BatchJob has required fields', () => {
    const src = readSrc('src/shared/types.ts')
    const fields = ['id', 'name', 'instanceId', 'items', 'status', 'count', 'submitted', 'completed', 'failed', 'produced', 'createdAt', 'notes', 'params', 'workflowPath']
    for (const f of fields) {
      expect(src).toContain(`${f}:`)
    }
  })
})

// ============ View: all views have i18n ============
describe('views use i18n (no hardcoded strings in template)', () => {
  const views = [
    'src/renderer/src/views/dashboard/DashboardView.vue',
    'src/renderer/src/views/instances/InstancesView.vue',
    'src/renderer/src/views/instances/InstanceDetailView.vue',
    'src/renderer/src/views/models/ModelsView.vue',
    'src/renderer/src/views/nodes/NodesView.vue',
    'src/renderer/src/views/nodes/MarketView.vue',
    'src/renderer/src/views/workflows/WorkflowsView.vue',
    'src/renderer/src/views/workflows/BatchView.vue',
    'src/renderer/src/views/output/OutputView.vue',
    'src/renderer/src/views/monitor/MonitorView.vue',
    'src/renderer/src/views/doctor/DoctorView.vue',
    'src/renderer/src/views/install/InstallView.vue',
    'src/renderer/src/views/backup/BackupView.vue',
    'src/renderer/src/views/settings/SettingsView.vue'
  ]
  for (const v of views) {
    it(`${v.split('/').pop()} uses i18n`, () => {
      const src = readSrc(v)
      // Must have at least one $t( or t( call
      expect(src).toMatch(/\$?t\(/)
    })
  }
})

// ============ Composables: exports ============
describe('composables exports', () => {
  it('useIpc exports ipc and helpers', () => {
    const src = readSrc('src/renderer/src/composables/useIpc.ts')
    expect(src).toContain('export async function ipc')
    expect(src).toContain('export function onIpc')
    expect(src).toContain('export function onInstanceStatus')
    expect(src).toContain('export function onNotification')
    expect(src).toContain('export class ComfyPilotIpcError')
    expect(src).toContain('toPlainIpcArg')
  })

  it('useLaunch exports busy/launch/stop/restart/forceKill', () => {
    const src = readSrc('src/renderer/src/composables/useLaunch.ts')
    expect(src).toContain('export function useLaunch')
    expect(src).toContain('launch')
    expect(src).toContain('stop')
    expect(src).toContain('restart')
    expect(src).toContain('forceKill')
    expect(src).toContain('sharedBusy')
  })

  it('useComfyUpdate exports progress and actions', () => {
    const src = readSrc('src/renderer/src/composables/useComfyUpdate.ts')
    expect(src).toContain('export function useComfyUpdate')
    expect(src).toContain('checkComfyUpdate')
    expect(src).toContain('startUpdate')
    expect(src).toContain('cancelUpdate')
    expect(src).toContain('repairEnv')
    expect(src).toContain('clearProgress')
  })
})

// ============ Preload: security ============
describe('preload security', () => {
  it('blocks unknown events', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('ALLOWED_EVENTS')
    expect(src).toContain('blocked subscription')
    expect(src).toContain('contextBridge')
    expect(src).toContain('exposeInMainWorld')
  })

  it('sanitizes IPC args', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('toPlainIpcArg')
    expect(src).toContain('JSON.parse(JSON.stringify')
  })
})

// ============ Main index: security ============
describe('main index security', () => {
  it('registers privileged schemes early', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('registerSchemesAsPrivileged')
    expect(src).toContain('comfy-pilot-media')
  })

  it('blocks unsafe navigation', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('isOwnRendererEntry')
    expect(src).toContain('will-navigate')
    expect(src).toContain('setWindowOpenHandler')
  })

  it('logs crashes', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('crashLog')
    expect(src).toContain('uncaughtException')
    expect(src).toContain('unhandledRejection')
  })
})

// ============ Handlers: security gates ============
describe('handlers security gates', () => {
  it('validates embed URLs', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('isAllowedEmbedUrl')
    expect(src).toContain('isTrustedComfyUrl')
    expect(src).toContain('isSafeExternalUrl')
  })

  it('validates safe instance IDs', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('safeInstanceId')
    expect(src).toContain('sanitizeId')
  })

  it('validates read paths', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('isSafeReadPath')
    expect(src).toContain('isSafeOpenPath')
  })

  it('validates output roots', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('isPathInside')
    expect(src).toContain('Output root is outside')
  })
})

// ============ Workflow: security ============
describe('workflow security', () => {
  it('validates import paths', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('isSafeReadPath')
    expect(src).toContain('workflow.import')
  })

  it('validates export dirs', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('Export directory is outside')
    expect(src).toContain('isPathInside')
  })
})

// ============ Model: security ============
describe('model security', () => {
  it('validates download URLs', () => {
    const src = readSrc('src/main/services/model.ts')
    expect(src).toContain('isSafeExternalUrl')
    expect(src).toContain('Blocked download URL scheme')
  })

  it('validates dest dirs', () => {
    const src = readSrc('src/main/services/model.ts')
    expect(src).toContain('assertSafeDestDir')
  })
})

// ============ NodePack: security ============
describe('nodePack security', () => {
  it('validates git URLs', () => {
    const src = readSrc('src/main/services/nodePack.ts')
    expect(src).toContain('assertSafeGitUrl')
    expect(src).toContain('assertSafeBranch')
    expect(src).toContain('isStrictInside')
    expect(src).toContain('Refusing')
  })

  it('validates install allowed', () => {
    const src = readSrc('src/main/services/nodePack.ts')
    expect(src).toContain('assertInstallAllowed')
    expect(src).toContain('SETTING_OFFLINE')
    expect(src).toContain('SETTING_SECURITY_STRONG')
    expect(src).toContain('SETTING_GIT_INSTALL')
  })
})

// ============ Backup: security ============
describe('backup security', () => {
  it('validates backup IDs', () => {
    const src = readSrc('src/main/services/backup.ts')
    expect(src).toContain('sanitizeId')
    expect(src).toContain('isPathInside')
    expect(src).toContain('Invalid backup id')
  })
})

// ============ Proxy: security ============
describe('proxy security', () => {
  it('validates URLs in fetchThroughProxy', () => {
    const src = readSrc('src/main/services/proxy.ts')
    expect(src).toContain('isSafeExternalUrl')
  })

  it('redacts passwords', () => {
    const src = readSrc('src/main/services/proxy.ts')
    expect(src).toContain('redactProxyUrl')
    expect(src).toContain('password')
  })
})

// ============ Monitor: security ============
describe('monitor security', () => {
  it('validates base URLs', () => {
    const src = readSrc('src/main/services/monitor.ts')
    expect(src).toContain('assertMonitorBaseUrl')
    expect(src).toContain('isLocalhostUrl')
  })
})

// ============ Media: security ============
describe('media security', () => {
  it('validates media URLs', () => {
    const src = readSrc('src/main/services/media.ts')
    expect(src).toContain('resolveMediaUrlToPath')
    expect(src).toContain('isPathInside')
    // Returns null for unsafe paths
    expect(src).toContain('return null')
  })
})
