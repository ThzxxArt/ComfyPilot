import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync, readdirSync } from 'fs'

const readSrc = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ All views have proper Vue SFC structure ============
describe('Vue SFC structure', () => {
  const views = [
    'dashboard/DashboardView.vue',
    'instances/InstancesView.vue',
    'instances/InstanceDetailView.vue',
    'models/ModelsView.vue',
    'nodes/NodesView.vue',
    'nodes/MarketView.vue',
    'workflows/WorkflowsView.vue',
    'workflows/BatchView.vue',
    'output/OutputView.vue',
    'monitor/MonitorView.vue',
    'doctor/DoctorView.vue',
    'install/InstallView.vue',
    'backup/BackupView.vue',
    'settings/SettingsView.vue',
    'embed/EmbedView.vue'
  ]
  for (const v of views) {
    it(`${v.split('/').pop()} has script setup and style`, () => {
      const src = readSrc(`src/renderer/src/views/${v}`)
      expect(src).toContain('<script setup')
      expect(src).toContain('<style')
    })
  }
})

// ============ All services use proper imports ============
describe('service imports from shared types', () => {
  const services = [
    'src/main/services/db.ts',
    'src/main/services/model.ts',
    'src/main/services/workflow.ts',
    'src/main/services/p1p2.ts',
    'src/main/services/nodePack.ts',
    'src/main/services/installer.ts',
    'src/main/services/updater.ts',
    'src/main/services/backup.ts'
  ]
  for (const f of services) {
    it(`${f.split('/').pop()} imports from @shared/types`, () => {
      const src = readSrc(f)
      expect(src).toMatch(
        /from ['"]@?\.?\.?\/?shared\/types['"]|from ['"]@shared\/types['"]|from ['"].*types['"]/
      )
    })
  }
})

// ============ IPC handler file structure ============
describe('handlers.ts structure', () => {
  it('has ok/fail/toPlainIpcData helpers', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('function ok')
    expect(src).toContain('function fail')
    expect(src).toContain('function toPlainIpcData')
    expect(src).toContain('function wrap')
  })

  it('has security helper functions', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('function safeInstanceId')
    expect(src).toContain('function isSafeReadPath')
    expect(src).toContain('function configuredComfyOrigins')
    expect(src).toContain('function isTrustedComfyUrl')
  })

  it('has broadcast and broadcastNotification', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('export function broadcast')
    expect(src).toContain('export function broadcastNotification')
  })

  it('has embed handling', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    expect(src).toContain('openEmbedInternal')
    expect(src).toContain('embedView')
  })
})

// ============ Main index.ts structure ============
describe('main/index.ts structure', () => {
  it('has crashLog and window management', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('function crashLog')
    expect(src).toContain('function createWindow')
    expect(src).toContain('function resolveAppIcon')
    expect(src).toContain('function revealWindow')
    expect(src).toContain('function isOwnRendererEntry')
  })

  it('has protocol handlers', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain("protocol.handle('comfy-pilot'")
    expect(src).toContain("protocol.handle('comfy-pilot-media'")
  })

  it('has tray and auto-start', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('createTray')
    expect(src).toContain('autoStart')
  })

  it('has electron-updater integration', () => {
    const src = readSrc('src/main/index.ts')
    expect(src).toContain('electron-updater')
    expect(src).toContain('checkForUpdatesAndNotify')
  })
})

// ============ Store structure ============
describe('app store structure', () => {
  it('has all state refs', () => {
    const src = readSrc('src/renderer/src/stores/app.ts')
    const refs = [
      'ready',
      'settings',
      'instances',
      'activeInstanceId',
      'instanceSwitchTick',
      'system',
      'doctorReport',
      'notifications',
      'notificationSeq',
      'remotes',
      'activeRemoteId'
    ]
    for (const r of refs) {
      expect(src, `missing ${r}`).toContain(r)
    }
  })

  it('has all computed properties', () => {
    const src = readSrc('src/renderer/src/stores/app.ts')
    const computeds = ['activeInstance', 'activeRemote', 'isRemoteActive', 'activeTargetUrl']
    for (const c of computeds) {
      expect(src, `missing ${c}`).toContain(c)
    }
  })

  it('has all functions', () => {
    const src = readSrc('src/renderer/src/stores/app.ts')
    const fns = [
      'bootstrap',
      'refreshInstances',
      'refreshRemotes',
      'bindLive',
      'pushNotification',
      'pruneActiveInstance',
      'syncWs'
    ]
    for (const f of fns) {
      expect(src, `missing ${f}`).toContain(f)
    }
  })
})

// ============ useComfyUpdate structure ============
describe('useComfyUpdate structure', () => {
  it('has all state', () => {
    const src = readSrc('src/renderer/src/composables/useComfyUpdate.ts')
    const states = [
      'progress',
      'progressKind',
      'updating',
      'updatingInstanceId',
      'cancelling',
      'nodeUpdatingPack',
      'nodeInstallingPack'
    ]
    for (const s of states) {
      expect(src, `missing ${s}`).toContain(s)
    }
  })

  it('has all actions', () => {
    const src = readSrc('src/renderer/src/composables/useComfyUpdate.ts')
    const actions = [
      'checkComfyUpdate',
      'startUpdate',
      'cancelUpdate',
      'repairEnv',
      'clearProgress'
    ]
    for (const a of actions) {
      expect(src, `missing ${a}`).toContain(a)
    }
  })

  it('has helper functions', () => {
    const src = readSrc('src/renderer/src/composables/useComfyUpdate.ts')
    expect(src).toContain('describeNodeError')
    expect(src).toContain('hasDepsSkippedIssue')
    expect(src).toContain('updateStepTitle')
    expect(src).toContain('updateDetailOf')
    expect(src).toContain('disposeComfyUpdateSubscriptions')
  })
})

// ============ useLaunch structure ============
describe('useLaunch structure', () => {
  it('has all actions', () => {
    const src = readSrc('src/renderer/src/composables/useLaunch.ts')
    const actions = ['launch', 'stop', 'restart', 'forceKill', 'handleLaunchError']
    for (const a of actions) {
      expect(src, `missing ${a}`).toContain(a)
    }
  })

  it('has busy state management', () => {
    const src = readSrc('src/renderer/src/composables/useLaunch.ts')
    expect(src).toContain('sharedBusy')
    expect(src).toContain('setBusy')
    expect(src).toContain('busy')
  })
})

// ============ i18n: key count stability ============
describe('i18n: key counts are stable', () => {
  it('zh-CN has 930+ value keys', () => {
    const src = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
    // Count string values
    const values = [...src.matchAll(/:\s*['"`][^'"`]*['"`]/g)].length
    expect(values).toBeGreaterThan(930)
  })

  it('en-US has 930+ value keys', () => {
    const src = readSrc('src/renderer/src/i18n/locales/en-US.ts')
    const values = [...src.matchAll(/:\s*['"`][^'"`]*['"`]/g)].length
    expect(values).toBeGreaterThan(930)
  })
})

// ============ Error codes in main services ============
describe('machine-readable error codes', () => {
  const codes = [
    'PORT_IN_USE',
    'SETTING_OFFLINE',
    'SETTING_GIT_INSTALL',
    'SETTING_SECURITY_STRONG',
    'OP_CANCELLED'
  ]
  const allSrc = [
    'src/main/services/instance.ts',
    'src/main/services/nodePack.ts',
    'src/main/services/installer.ts',
    'src/main/services/updater.ts',
    'src/main/ipc/handlers.ts'
  ]
    .map((f) => readSrc(f))
    .join('\n')

  for (const code of codes) {
    it(`code '${code}' is used`, () => {
      expect(allSrc).toContain(code)
    })
  }
})

// ============ Version consistency ============
describe('version consistency across files', () => {
  it('package.json and constants.ts fallback agree (dynamic)', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    const constants = readSrc('src/shared/constants.ts')
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(constants).toContain(`'${pkg.version}'`)
  })
})

// ============ Test file names match patterns ============
describe('test file naming', () => {
  it('every test file in tests/unit follows the *.test.ts convention', () => {
    // 真实目录扫描（只校验文件，跳过 __snapshots__ 之类的子目录）。
    const files = readdirSync(join(__dirname), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
    expect(files.length).toBeGreaterThan(40)
    // Report the exact offenders instead of a bare regex mismatch per file.
    expect(files.filter((f) => !f.endsWith('.test.ts'))).toEqual([])
  })
})

// ============ Composable: useIpc structure ============
describe('useIpc structure', () => {
  it('exports all needed helpers', () => {
    const src = readSrc('src/renderer/src/composables/useIpc.ts')
    const exports = [
      'toPlainIpcArg',
      'ComfyPilotIpcError',
      'ipc',
      'onIpc',
      'onInstanceStatus',
      'onMonitorTick',
      'onDownloadProgress',
      'onModelScanProgress',
      'onNotification',
      'onDoctorProgress',
      'onBatchProgress',
      'onRegistryIndexProgress'
    ]
    for (const e of exports) {
      expect(src, `missing ${e}`).toContain(e)
    }
  })
})

// ============ Router: lazy imports ============
describe('router: lazy component loading', () => {
  it('all routes use dynamic import', () => {
    const src = readSrc('src/renderer/src/router/index.ts')
    const imports = (src.match(/import\(/g) || []).length
    expect(imports).toBeGreaterThanOrEqual(14)
  })
})

// ============ Styles: design tokens ============
describe('styles: design tokens', () => {
  it('tokens.ts exports COLORS', () => {
    const src = readSrc('src/renderer/src/styles/tokens.ts')
    expect(src).toContain('COLORS')
    expect(src).toContain('primary')
    expect(src).toContain('export')
  })

  it('variables.scss has key variables', () => {
    const src = readSrc('src/renderer/src/styles/variables.scss')
    expect(src).toContain('$nav-width')
    expect(src).toContain('$header-height')
    expect(src).toContain('$gradient-primary')
    expect(src).toContain('$shadow-')
  })
})

// ============ Format utilities ============
describe('format: exports', () => {
  it('exports formatBytes and clampPercent', () => {
    const src = readSrc('src/renderer/src/utils/format.ts')
    expect(src).toContain('export function formatBytes')
    expect(src).toContain('export function clampPercent')
  })
})

// ============ env.d.ts ============
describe('env.d.ts', () => {
  it('declares __APP_VERSION__ and vue modules', () => {
    const src = readSrc('src/renderer/src/env.d.ts')
    expect(src).toContain('__APP_VERSION__')
    expect(src).toContain('*.vue')
    expect(src).toContain('vite/client')
  })
})

// ============ preload/index.d.ts ============
describe('preload types', () => {
  it('declares ComfyPilotApi', () => {
    const src = readSrc('src/preload/index.d.ts')
    expect(src).toContain('ComfyPilotApi')
  })
})
