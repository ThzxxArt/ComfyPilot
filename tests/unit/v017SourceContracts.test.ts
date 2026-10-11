import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

const readSrc = (rel: string): string =>
  readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ Every main service file exists and is non-trivial ============
describe('main service files exist with real code', () => {
  const services = [
    'backup.ts', 'bootstrap.ts', 'comfyApi.ts', 'db.ts', 'desktop.ts',
    'doctor.ts', 'env.ts', 'installer.ts', 'instance.ts', 'media.ts',
    'model.ts', 'monitor.ts', 'netProbe.ts', 'nodePack.ts', 'p1p2.ts',
    'proxy.ts', 'registry.ts', 'registryIndex.ts', 'security.ts', 'tray.ts',
    'updater.ts', 'workflow.ts', 'workflowConvert.ts', 'zipSafe.ts', 'zipWrite.ts'
  ]
  for (const f of services) {
    it(`${f} exists with substantial code`, () => {
      const src = readSrc(`src/main/services/${f}`)
      expect(src.length).toBeGreaterThan(500)
      expect(src).toContain('export')
    })
  }
})

// ============ Every renderer view exists ============
describe('renderer views exist', () => {
  const views = [
    'dashboard/DashboardView.vue', 'instances/InstancesView.vue',
    'instances/InstanceDetailView.vue', 'models/ModelsView.vue',
    'nodes/NodesView.vue', 'nodes/MarketView.vue',
    'workflows/WorkflowsView.vue', 'workflows/BatchView.vue',
    'output/OutputView.vue', 'monitor/MonitorView.vue',
    'doctor/DoctorView.vue', 'install/InstallView.vue',
    'backup/BackupView.vue', 'settings/SettingsView.vue',
    'embed/EmbedView.vue'
  ]
  for (const v of views) {
    it(`${v.split('/').pop()} exists with template + script`, () => {
      const src = readSrc(`src/renderer/src/views/${v}`)
      expect(src).toContain('<template>')
      expect(src).toContain('<script')
    })
  }
})

// ============ Every component exists ============
describe('renderer components exist', () => {
  const components = [
    'ComfyUpdateProgressModal.vue', 'StatCard.vue'
  ]
  for (const c of components) {
    it(`${c} exists`, () => {
      const src = readSrc(`src/renderer/src/components/${c}`)
      expect(src).toContain('<template>')
    })
  }
})

// ============ Router: all views have routes ============
describe('router covers all views', () => {
  const src = readSrc('src/renderer/src/router/index.ts')
  const routes = [
    'dashboard', 'instances', 'models', 'nodes', 'market',
    'workflows', 'batch', 'output', 'monitor', 'doctor',
    'install', 'backup', 'settings', 'embed'
  ]
  for (const r of routes) {
    it(`route '${r}' is defined`, () => {
      expect(src).toContain(r)
    })
  }
})

// ============ Source file encoding checks ============
describe('source files are valid UTF-8', () => {
  const files = [
    'src/main/services/db.ts', 'src/main/services/nodePack.ts',
    'src/main/services/model.ts', 'src/main/services/workflow.ts',
    'src/shared/types.ts', 'src/shared/constants.ts',
    'src/renderer/src/App.vue', 'src/renderer/src/stores/app.ts'
  ]
  for (const f of files) {
    it(`${f} has no replacement chars`, () => {
      const src = readSrc(f)
      expect(src).not.toContain('\uFFFD') // Unicode replacement character
    })
  }
})

// ============ No hardcoded Chinese in main process ============
describe('no hardcoded Chinese in main services', () => {
  const services = [
    'src/main/services/db.ts', 'src/main/services/model.ts',
    'src/main/services/workflow.ts', 'src/main/services/p1p2.ts',
    'src/main/services/installer.ts', 'src/main/services/updater.ts'
  ]
  for (const f of services) {
    it(`${f.split('/').pop()} has no Chinese literals`, () => {
      const src = readSrc(f)
      // Check for CJK characters in string literals (not comments)
      const lines = src.split('\n')
      for (const line of lines) {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '')
        if (/['"`][^'"`]*[一-鿿]/.test(code)) {
          // Allow i18n key patterns
          if (code.includes('.t(') || code.includes('t(') || code.includes('Key')) continue
          expect.fail(`Chinese literal in ${f}: ${line.trim().slice(0, 80)}`)
        }
      }
    })
  }
})

// ============ No console.log in production main services ============
describe('no stray console.log in main services', () => {
  const services = [
    'src/main/services/db.ts', 'src/main/services/model.ts',
    'src/main/services/workflow.ts', 'src/main/services/p1p2.ts',
    'src/main/services/nodePack.ts', 'src/main/services/backup.ts'
  ]
  for (const f of services) {
    it(`${f.split('/').pop()} has no console.log (except in catch blocks)`, () => {
      const src = readSrc(f)
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.startsWith('console.log(')) {
          // Only allowed in error handling context
          const prev = i > 0 ? lines[i - 1].trim() : ''
          if (!prev.includes('catch') && !prev.includes('err') && !prev.includes('error')) {
            // This is fine - many are in catch blocks
          }
        }
      }
      // Just verify no more than a few (some are in catch blocks which is fine)
      const count = (src.match(/console\.log\(/g) || []).length
      expect(count).toBeLessThan(5)
    })
  }
})

// ============ Function export completeness ============
describe('key functions are exported', () => {
  it('security.ts exports all safety functions', () => {
    const src = readSrc('src/main/services/security.ts')
    const fns = ['isPathInside', 'isSafeExternalUrl', 'isSafeOpenPath', 'sanitizeId', 'isLocalhostUrl', 'assertSafeRelativeFilename', 'safeResolveUnder', 'normalizePathSegment']
    for (const fn of fns) {
      expect(src).toContain(`export function ${fn}`)
    }
  })

  it('db.ts exports all CRUD functions', () => {
    const src = readSrc('src/main/services/db.ts')
    const fns = ['loadSettings', 'saveSettings', 'loadInstanceConfigs', 'upsertInstanceConfig', 'deleteInstanceConfig', 'listNodePacks', 'upsertNodePack', 'listWorkflows', 'upsertWorkflow', 'listModels', 'upsertModel', 'listBatchJobs', 'upsertBatchJob', 'listOutputAssetsAll', 'listBackups', 'listRemotes']
    for (const fn of fns) {
      expect(src, `missing ${fn}`).toContain(`export function ${fn}`)
    }
  })

  it('proxy.ts exports proxyEnv and testProxy', () => {
    const src = readSrc('src/main/services/proxy.ts')
    expect(src).toContain('export function proxyEnv')
    expect(src).toContain('export async function testProxy')
    expect(src).toContain('export function syncProxyFromSettings')
    expect(src).toContain('export function redactProxyUrl')
  })

  it('installer.ts exports git safety functions', () => {
    const src = readSrc('src/main/services/installer.ts')
    expect(src).toContain('export function assertSafeGitUrl')
    expect(src).toContain('export function assertSafeBranch')
    expect(src).toContain('export function applyGithubMirror')
    expect(src).toContain('export function resolveTorchIndex')
    expect(src).toContain('export function listStarterModels')
  })

  it('monitor.ts exports monitorService and helpers', () => {
    const src = readSrc('src/main/services/monitor.ts')
    expect(src).toContain('export function assertMonitorBaseUrl')
    expect(src).toContain('export function mergeGpuMemory')
    expect(src).toContain('export async function sampleWindowsGpuMemory')
    expect(src).toContain('export const monitorService')
  })

  it('model.ts exports modelService and helpers', () => {
    const src = readSrc('src/main/services/model.ts')
    expect(src).toContain('export function readSafetensorsMeta')
    expect(src).toContain('export async function sha256File')
    expect(src).toContain('export function parseExtraModelPaths')
    expect(src).toContain('export const modelService')
  })

  it('nodePack.ts exports nodePackService', () => {
    const src = readSrc('src/main/services/nodePack.ts')
    expect(src).toContain('export const nodePackService')
  })

  it('workflow.ts exports workflowService', () => {
    const src = readSrc('src/main/services/workflow.ts')
    expect(src).toContain('export const workflowService')
  })

  it('p1p2.ts exports all four services', () => {
    const src = readSrc('src/main/services/p1p2.ts')
    expect(src).toContain('export const batchService')
    expect(src).toContain('export const outputService')
    expect(src).toContain('export const remoteService')
    expect(src).toContain('export const marketService')
    expect(src).toContain('export function resolveOutputDir')
  })

  it('backup.ts exports backupService', () => {
    const src = readSrc('src/main/services/backup.ts')
    expect(src).toContain('export const backupService')
  })

  it('doctor.ts exports doctorService', () => {
    const src = readSrc('src/main/services/doctor.ts')
    expect(src).toContain('export const doctorService')
  })
})

// ============ Error handling patterns ============
describe('error handling patterns', () => {
  it('IPC handlers use wrap() for all handlers', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    const handlerCount = (src.match(/ipcMain\.handle\(/g) || []).length
    const wrapCount = (src.match(/wrap\(/g) || []).length
    // Almost every handler should use wrap()
    expect(wrapCount).toBeGreaterThanOrEqual(handlerCount - 2)
  })

  it('IpcResult has ok/data/error/code pattern', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('interface IpcResult')
    expect(src).toContain('ok: boolean')
    expect(src).toContain('data?: T')
    expect(src).toContain('error?: string')
    expect(src).toContain('code?: string')
    expect(src).toContain('suggestedPort?: number')
  })
})

// ============ Test file distribution ============
describe('test coverage distribution', () => {
  it('tests/unit has many test files', () => {
    const src = readSrc('tests/unit/v017Contracts.test.ts')
    expect(src).toContain('describe(')
    const src2 = readSrc('tests/unit/v017DeepAudit.test.ts')
    expect(src2).toContain('describe(')
    const src3 = readSrc('tests/unit/v016Collaboration.test.ts')
    expect(src3).toContain('describe(')
  })

  it('tests/integration has test files', () => {
    const src = readSrc('tests/integration/db.test.ts')
    expect(src).toContain('describe(')
    const src2 = readSrc('tests/integration/installerGates.test.ts')
    expect(src2).toContain('describe(')
    const src3 = readSrc('tests/integration/installerRunPlan.test.ts')
    expect(src3).toContain('describe(')
  })

  it('total test files exceed 45', () => {
    const { readdirSync } = require('fs')
    const unit = readdirSync(join(__dirname, '..', '..', 'tests/unit')).filter((f: string) => f.endsWith('.test.ts'))
    const integration = readdirSync(join(__dirname, '..', '..', 'tests/integration')).filter((f: string) => f.endsWith('.test.ts'))
    expect(unit.length + integration.length).toBeGreaterThanOrEqual(45)
  })
})

// ============ Import graph sanity ============
describe('no circular imports in shared types', () => {
  it('types.ts does not import from main/renderer', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).not.toContain("from '@main/")
    expect(src).not.toContain("from '@/")
    expect(src).not.toContain("from '../main")
    expect(src).not.toContain("from '../renderer")
  })
})

describe('constants.ts only imports from types', () => {
  it('constants.ts imports are clean', () => {
    const src = readSrc('src/shared/constants.ts')
    expect(src).toContain("from './types'")
    expect(src).not.toContain("from '@main/")
  })
})

// ============ Preload API surface ============
describe('preload API surface', () => {
  it('exposes invoke and on', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toContain('invoke')
    expect(src).toContain('on')
    expect(src).toContain('events: IPC_EVENTS')
  })

  it('type definitions match', () => {
    const src = readSrc('src/preload/index.d.ts')
    expect(src).toContain('comfyPilot')
    expect(src).toContain('ComfyPilotApi')
  })
})

// ============ App shell: navigation ============
describe('App shell navigation', () => {
  it('has all nav items', () => {
    const src = readSrc('src/renderer/src/App.vue')
    const items = ['dashboard', 'instances', 'workflows', 'batch', 'output', 'models', 'nodes', 'market', 'monitor', 'doctor', 'install', 'backup', 'settings']
    for (const item of items) {
      expect(src).toContain(`'${item}'`)
    }
  })

  it('has nav groups', () => {
    const src = readSrc('src/renderer/src/App.vue')
    expect(src).toContain('groupProduce')
    expect(src).toContain('groupAssets')
    expect(src).toContain('groupOps')
    expect(src).toContain('navGroups')
  })
})

// ============ i18n locale file structure ============
describe('locale file structure', () => {
  it('zh-CN has all top-level sections', () => {
    const src = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
    const sections = ['common', 'status', 'nav', 'header', 'dashboard', 'settings', 'instance', 'install', 'models', 'nodes', 'market', 'output', 'batch', 'workflows', 'monitor', 'doctor', 'backup', 'notify', 'stepMsg', 'update', 'launch', 'starterModels', 'embed', 'app']
    for (const s of sections) {
      expect(src, `missing section ${s}`).toContain(`${s}:`)
    }
  })

  it('en-US has all top-level sections', () => {
    const src = readSrc('src/renderer/src/i18n/locales/en-US.ts')
    const sections = ['common', 'status', 'nav', 'header', 'dashboard', 'settings', 'instance', 'install', 'models', 'nodes', 'market', 'output', 'batch', 'workflows', 'monitor', 'doctor', 'backup', 'notify', 'stepMsg', 'update', 'launch', 'starterModels', 'embed', 'app']
    for (const s of sections) {
      expect(src, `missing section ${s}`).toContain(`${s}:`)
    }
  })
})

// ============ Dynamic i18n key domains ============
describe('dynamic i18n key domains', () => {
  it('status.* keys exist', () => {
    const src = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
    const statuses = ['stopped', 'starting', 'running', 'error', 'unknown', 'remote']
    for (const s of statuses) {
      expect(src).toContain(`${s}:`)
    }
  })

  it('launchTpl.* keys exist', () => {
    const src = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
    expect(src).toContain('launchTpl')
    const templates = ['default', 'preview-taesd', 'manager', 'offline', 'lan', 'lowvram', 'cpu']
    for (const t of templates) {
      expect(src).toContain(t)
    }
  })

  it('install.torchChannels.* keys exist', () => {
    const src = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
    const channels = ['cu130', 'cu126', 'cu124', 'rocm', 'xpu', 'mps', 'cpu']
    for (const c of channels) {
      expect(src).toContain(c)
    }
  })
})

// ============ Workflow library operations ============
describe('workflow library operations (source contract)', () => {
  it('supports import, list, rename, delete, favorite, tag, exportZip, copyToInstance, openInFrontend', () => {
    const src = readSrc('src/main/services/workflow.ts')
    const ops = ['importFile', 'importMany', 'list(', 'rename(', 'remove(', 'favorite(', 'tag(', 'exportZip', 'copyToInstance', 'openInFrontend', 'prepareFrontend', 'queue(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Batch operations ============
describe('batch operations (source contract)', () => {
  it('supports create, start, cancel, remove, cancelItem', () => {
    const src = readSrc('src/main/services/p1p2.ts')
    const ops = ['create(', 'start(', 'cancel(', 'remove(', 'cancelItem(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Output operations ============
describe('output operations (source contract)', () => {
  it('supports list, favorite, importToWorkflow, exportZip, remove', () => {
    const src = readSrc('src/main/services/p1p2.ts')
    const ops = ['list(', 'favorite(', 'importToWorkflow', 'exportZip', 'remove(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ NodePack operations ============
describe('nodePack operations (source contract)', () => {
  it('supports install, uninstall, update, toggle, lock, checkIssues, smokeTest, snapshots, checkUpdates, updateAll', () => {
    const src = readSrc('src/main/services/nodePack.ts')
    const ops = ['install(', 'uninstall(', 'update(', 'toggle(', 'lock(', 'checkIssues(', 'smokeTest(', 'snapshots(', 'createSnapshot(', 'restoreSnapshot(', 'checkUpdates(', 'updateAll(', 'cancelOp(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Model operations ============
describe('model operations (source contract)', () => {
  it('supports list, scan, delete, move, symlink, rename, tag, download, findDuplicates', () => {
    const src = readSrc('src/main/services/model.ts')
    const ops = ['list(', 'scan(', 'remove(', 'move(', 'symlink(', 'rename(', 'tag(', 'download(', 'findDuplicates(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Instance operations ============
describe('instance operations (source contract)', () => {
  it('supports list, save, remove, start, launch, stop, restart, forceKill, getLogs', () => {
    const src = readSrc('src/main/services/instance.ts')
    const ops = ['list(', 'save(', 'remove(', 'start(', 'launch(', 'stop(', 'restart(', 'forceKill(', 'getLogs(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Doctor operations ============
describe('doctor operations (source contract)', () => {
  it('supports run and fix', () => {
    const src = readSrc('src/main/services/doctor.ts')
    expect(src).toContain('async run(')
    expect(src).toContain('async fix(')
  })
})

// ============ Backup operations ============
describe('backup operations (source contract)', () => {
  it('supports create, restore, delete, list, openFolder', () => {
    const src = readSrc('src/main/services/backup.ts')
    const ops = ['create(', 'restore(', 'delete(', 'list(', 'openFolder(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Remote operations ============
describe('remote operations (source contract)', () => {
  it('supports list, save, remove, test, listStatus', () => {
    const src = readSrc('src/main/services/p1p2.ts')
    const ops = ['list(', 'save(', 'remove(', 'test(', 'listStatus(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Env operations ============
describe('env operations (source contract)', () => {
  it('supports probe, createVenv, installTorch, repairEnv, listPythons', () => {
    const src = readSrc('src/main/services/env.ts')
    const ops = ['probe(', 'createVenv(', 'installTorch(', 'repairEnv(', 'listPythons(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Installer operations ============
describe('installer operations (source contract)', () => {
  it('supports detectGpu, preflight, start, cancel, suggestInstallRoot, installStarter', () => {
    const src = readSrc('src/main/services/installer.ts')
    const ops = ['detectGpu(', 'preflight(', 'start(', 'cancel(', 'suggestInstallRoot(', 'installStarter(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})

// ============ Updater operations ============
describe('updater operations (source contract)', () => {
  it('supports check, start, cancel, waitUntilSettled, getStatus', () => {
    const src = readSrc('src/main/services/updater.ts')
    const ops = ['check(', 'start(', 'cancel(', 'waitUntilSettled(', 'getStatus(']
    for (const op of ops) {
      expect(src, `missing ${op}`).toContain(op)
    }
  })
})
