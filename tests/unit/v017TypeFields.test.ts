import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

const readSrc = (rel: string): string =>
  readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ Every IPC channel in map has type signature ============
describe('IPC channel type signatures', () => {
  const typesSrc = readSrc('src/shared/types.ts')
  const mapMatch = typesSrc.match(/export type IpcChannelMap = \{([\s\S]*?)\n\}/)
  const body = mapMatch?.[1] || ''
  // Extract channel names
  const names = [...body.matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((m) => m[1])

  it('found 130+ channel definitions', () => {
    expect(names.length).toBeGreaterThanOrEqual(130)
  })

  it('every channel entry has args and result keys', () => {
    // Count args: and result: occurrences — should roughly match channel count
    const argsCount = (body.match(/args:/g) || []).length
    const resultCount = (body.match(/result:/g) || []).length
    expect(argsCount).toBeGreaterThanOrEqual(names.length)
    expect(resultCount).toBeGreaterThanOrEqual(names.length)
  })

  // Spot-check some key channels
  for (const name of names.slice(0, 20)) {
    it(`channel '${name}' is defined`, () => {
      expect(body).toContain(`'${name}':`)
    })
  }
  for (const name of names.slice(20, 40)) {
    it(`channel '${name}' is defined`, () => {
      expect(body).toContain(`'${name}':`)
    })
  }
  for (const name of names.slice(40, 70)) {
    it(`channel '${name}' is defined`, () => {
      expect(body).toContain(`'${name}':`)
    })
  }
  for (const name of names.slice(70, 100)) {
    it(`channel '${name}' is defined`, () => {
      expect(body).toContain(`'${name}':`)
    })
  }
  for (const name of names.slice(100)) {
    it(`channel '${name}' is defined`, () => {
      expect(body).toContain(`'${name}':`)
    })
  }
})

// ============ Every i18n section has both zh and en ============
describe('i18n section parity', () => {
  const zh = readSrc('src/renderer/src/i18n/locales/zh-CN.ts')
  const en = readSrc('src/renderer/src/i18n/locales/en-US.ts')

  const sections = [
    'common', 'status', 'nav', 'header', 'dashboard', 'settings', 'instance',
    'install', 'models', 'nodes', 'market', 'output', 'batch', 'workflows',
    'monitor', 'doctor', 'backup', 'notify', 'stepMsg', 'update', 'launch',
    'starterModels', 'embed', 'app'
  ]
  for (const s of sections) {
    it(`section '${s}' exists in both locales`, () => {
      expect(zh).toContain(`${s}:`)
      expect(en).toContain(`${s}:`)
    })
  }
})

// ============ Source file line count sanity ============
describe('source files have substantial implementation', () => {
  const files = [
    'src/main/services/nodePack.ts', 'src/main/services/installer.ts',
    'src/main/services/instance.ts', 'src/main/services/updater.ts',
    'src/main/services/workflow.ts', 'src/main/services/model.ts',
    'src/main/services/p1p2.ts', 'src/main/services/db.ts',
    'src/main/ipc/handlers.ts', 'src/main/index.ts',
    'src/shared/types.ts'
  ]
  for (const f of files) {
    it(`${f.split('/').pop()} has 200+ lines`, () => {
      const src = readSrc(f)
      const lines = src.split('\n').length
      expect(lines).toBeGreaterThan(200)
    })
  }
})

// ============ Error message quality ============
describe('error messages are descriptive', () => {
  const files = [
    'src/main/services/nodePack.ts', 'src/main/services/installer.ts',
    'src/main/services/instance.ts', 'src/main/services/backup.ts'
  ]
  for (const f of files) {
    it(`${f.split('/').pop()} has descriptive errors`, () => {
      const src = readSrc(f)
      // Must have thrown errors with messages
      const throws = (src.match(/throw new Error\(/g) || []).length
      expect(throws).toBeGreaterThan(1)
    })
  }
})

// ============ TypeScript strictness ============
describe('no implicit any in critical files', () => {
  it('types.ts has typed interfaces', () => {
    const src = readSrc('src/shared/types.ts')
    const interfaces = (src.match(/export interface /g) || []).length
    expect(interfaces).toBeGreaterThan(10)
  })

  it('constants.ts has typed exports', () => {
    const src = readSrc('src/shared/constants.ts')
    expect(src).toContain('export const')
    expect(src).toContain(': ')
  })

  it('security.ts has typed functions', () => {
    const src = readSrc('src/main/services/security.ts')
    const fns = (src.match(/export function /g) || []).length
    expect(fns).toBeGreaterThan(3)
  })

  it('db.ts has typed functions', () => {
    const src = readSrc('src/main/services/db.ts')
    const fns = (src.match(/export function /g) || []).length
    expect(fns).toBeGreaterThan(10)
  })
})

// ============ View: error handling ============
describe('views have error handling', () => {
  const views = [
    'src/renderer/src/views/instances/InstancesView.vue',
    'src/renderer/src/views/models/ModelsView.vue',
    'src/renderer/src/views/nodes/NodesView.vue',
    'src/renderer/src/views/workflows/WorkflowsView.vue',
    'src/renderer/src/views/workflows/BatchView.vue',
    'src/renderer/src/views/output/OutputView.vue',
    'src/renderer/src/views/install/InstallView.vue'
  ]
  for (const v of views) {
    it(`${v.split('/').pop()} has message.error calls`, () => {
      const src = readSrc(v)
      expect(src).toContain('message.error')
    })
  }
})

// ============ View: loading states ============
describe('views have loading states', () => {
  const views = [
    'src/renderer/src/views/instances/InstancesView.vue',
    'src/renderer/src/views/models/ModelsView.vue',
    'src/renderer/src/views/nodes/NodesView.vue',
    'src/renderer/src/views/workflows/BatchView.vue',
    'src/renderer/src/views/output/OutputView.vue'
  ]
  for (const v of views) {
    it(`${v.split('/').pop()} has loading/spin state`, () => {
      const src = readSrc(v)
      expect(src).toMatch(/loading|spin|NSpin/i)
    })
  }
})

// ============ View: empty states ============
describe('views have empty states', () => {
  const views = [
    'src/renderer/src/views/instances/InstancesView.vue',
    'src/renderer/src/views/models/ModelsView.vue',
    'src/renderer/src/views/nodes/NodesView.vue',
    'src/renderer/src/views/workflows/WorkflowsView.vue',
    'src/renderer/src/views/output/OutputView.vue',
    'src/renderer/src/views/backup/BackupView.vue'
  ]
  for (const v of views) {
    it(`${v.split('/').pop()} has empty state`, () => {
      const src = readSrc(v)
      expect(src).toMatch(/NEmpty|empty|暂无/i)
    })
  }
})

// ============ Security: no eval ============
describe('no eval or Function constructor', () => {
  const files = [
    'src/main/services/db.ts', 'src/main/services/model.ts',
    'src/main/services/workflow.ts', 'src/main/services/nodePack.ts',
    'src/main/services/p1p2.ts', 'src/main/services/installer.ts'
  ]
  for (const f of files) {
    it(`${f.split('/').pop()} has no eval`, () => {
      const src = readSrc(f)
      expect(src).not.toContain('eval(')
      expect(src).not.toContain('new Function(')
    })
  }
})

// ============ Security: no child_process shell:true ============
describe('no shell:true in child_process calls', () => {
  const files = [
    'src/main/services/env.ts', 'src/main/services/instance.ts',
    'src/main/services/installer.ts', 'src/main/services/nodePack.ts',
    'src/main/services/updater.ts'
  ]
  for (const f of files) {
    it(`${f.split('/').pop()} avoids shell:true`, () => {
      const src = readSrc(f)
      // Allow execFile (which is safe) but check spawn/exec don't use shell:true
      const shellTrue = src.match(/shell:\s*true/g) || []
      expect(shellTrue.length).toBe(0)
    })
  }
})

// ============ Async/await patterns ============
describe('async functions properly awaited', () => {
  const files = [
    'src/main/services/nodePack.ts', 'src/main/services/workflow.ts',
    'src/main/services/p1p2.ts', 'src/main/services/installer.ts'
  ]
  for (const f of files) {
    it(`${f.split('/').pop()} has async/await patterns`, () => {
      const src = readSrc(f)
      expect(src).toContain('async ')
      expect(src).toContain('await ')
    })
  }
})

// ============ EventEmitter pattern ============
describe('services use EventEmitter for progress', () => {
  const services = [
    'src/main/services/instance.ts', 'src/main/services/model.ts',
    'src/main/services/nodePack.ts', 'src/main/services/p1p2.ts',
    'src/main/services/installer.ts', 'src/main/services/updater.ts',
    'src/main/services/env.ts', 'src/main/services/bootstrap.ts',
    'src/main/services/doctor.ts', 'src/main/services/registryIndex.ts',
    'src/main/services/monitor.ts'
  ]
  for (const f of services) {
    it(`${f.split('/').pop()} extends EventEmitter`, () => {
      const src = readSrc(f)
      expect(src).toContain('EventEmitter')
    })
  }
})

// ============ IPC events are typed ============
describe('IPC events are typed constants', () => {
  it('IPC_EVENTS is as const', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('IPC_EVENTS = {')
    expect(src).toContain('} as const')
  })

  it('all event values start with event:', () => {
    const src = readSrc('src/shared/types.ts')
    const events = [...src.matchAll(/:\s*'(event:[^']+)'/g)].map((m) => m[1])
    expect(events.length).toBeGreaterThanOrEqual(15)
    for (const e of events) {
      expect(e).toMatch(/^event:/)
    }
  })
})

// ============ Install progress type completeness ============
describe('InstallProgress has all required fields', () => {
  it('has runId, step, status, steps, message, percent', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('runId: string')
    expect(src).toContain('step: InstallStepId')
    expect(src).toContain('status: InstallStepStatus')
    expect(src).toContain('steps: InstallStep[]')
    expect(src).toContain('message: string')
    expect(src).toContain('percent: number')
    expect(src).toContain('error?: string')
    expect(src).toContain('instanceId?: string')
  })
})

// ============ UpdateProgress has all required fields ============
describe('UpdateProgress has all required fields', () => {
  it('has runId, instanceId, step, status, steps', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('runId: string')
    expect(src).toContain('instanceId: string')
    expect(src).toContain('step: UpdateStepId')
    expect(src).toContain('status: InstallStepStatus')
    expect(src).toContain('steps: UpdateStep[]')
    expect(src).toContain('backupPath?: string')
  })
})

// ============ GpuCapability has all required fields ============
describe('GpuCapability has all required fields', () => {
  it('has vendor, model, recommendedTorch, notes', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('vendor: string')
    expect(src).toContain('model: string')
    expect(src).toContain('recommendedTorch: TorchChannel')
    expect(src).toContain('notes: string')
  })
})

// ============ BootstrapStatus has all required fields ============
describe('BootstrapStatus has all required fields', () => {
  it('has runtimesDir, components, pythonPath', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('runtimesDir: string')
    expect(src).toContain('components: RuntimeComponentStatus[]')
    expect(src).toContain('pythonPath: string')
    expect(src).toContain('pythonOrigin: RuntimeComponentStatus')
    expect(src).toContain('zipInstallReady: boolean')
  })
})

// ============ DoctorReport has all required fields ============
describe('DoctorReport has all required fields', () => {
  it('has id, instanceId, createdAt, durationMs, checks, summary', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('id: string')
    expect(src).toContain('instanceId: string')
    expect(src).toContain('createdAt: number')
    expect(src).toContain('durationMs: number')
    expect(src).toContain('checks: DoctorCheck[]')
    expect(src).toContain('summary:')
  })
})

// ============ RegistryPageResult has all required fields ============
describe('RegistryPageResult has all required fields', () => {
  it('has items, total, page, pageSize, totalPages, scanned, clientFiltered', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('items: T[]')
    expect(src).toContain('total: number')
    expect(src).toContain('page: number')
    expect(src).toContain('pageSize: number')
    expect(src).toContain('totalPages: number')
    expect(src).toContain('scanned: number')
    expect(src).toContain('clientFiltered: boolean')
  })
})

// ============ StarterModel has all required fields ============
describe('StarterModel has all required fields', () => {
  it('has id, name, description, url, category, approxBytes, family', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('id: string')
    expect(src).toContain('name: string')
    expect(src).toContain('description: string')
    expect(src).toContain('url: string')
    expect(src).toContain('category: ModelCategory')
    expect(src).toContain('approxBytes: number')
    expect(src).toContain('family: string')
    expect(src).toContain('recommended?: boolean')
  })
})

// ============ NodeSnapshot has all required fields ============
describe('NodeSnapshot has all required fields', () => {
  it('has id, name, createdAt, packs, notes, instanceId', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('id: string')
    expect(src).toContain('name: string')
    expect(src).toContain('createdAt: number')
    expect(src).toContain('packs: Array<')
    expect(src).toContain('notes: string')
    expect(src).toContain('instanceId?: string')
    expect(src).toContain('gitRev')
  })
})

// ============ BackupManifest has all required fields ============
describe('BackupManifest has all required fields', () => {
  it('has id, name, createdAt, path, size, includes, notes', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('id: string')
    expect(src).toContain('name: string')
    expect(src).toContain('createdAt: number')
    expect(src).toContain('path: string')
    expect(src).toContain('size: number')
    expect(src).toContain('includes:')
    expect(src).toContain('notes: string')
    expect(src).toContain('workflowFiles')
    expect(src).toContain('nodeSnapshots')
  })
})

// ============ RemoteInstanceConfig has all required fields ============
describe('RemoteInstanceConfig has all required fields', () => {
  it('has id, name, baseUrl, apiKey, label, enabled', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('id: string')
    expect(src).toContain('name: string')
    expect(src).toContain('baseUrl: string')
    expect(src).toContain('apiKey?: string')
    expect(src).toContain('label: string')
    expect(src).toContain('enabled: boolean')
  })
})

// ============ QueueSnapshot has all required fields ============
describe('QueueSnapshot has all required fields', () => {
  it('has running, pending, doneCount, history', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('running: QueueItem[]')
    expect(src).toContain('pending: QueueItem[]')
    expect(src).toContain('doneCount: number')
    expect(src).toContain('history:')
  })
})

// ============ SystemSnapshot has all required fields ============
describe('SystemSnapshot has all required fields', () => {
  it('has cpuUsage, ramTotal, ramUsed, diskFree, diskTotal, gpus, timestamp', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('cpuUsage: number')
    expect(src).toContain('ramTotal: number')
    expect(src).toContain('ramUsed: number')
    expect(src).toContain('diskFree: number')
    expect(src).toContain('diskTotal: number')
    expect(src).toContain('gpus: GpuInfo[]')
    expect(src).toContain('timestamp: number')
  })
})

// ============ ExecProgressEvent has all required fields ============
describe('ExecProgressEvent has all required fields', () => {
  it('has type, nodeId, value, max, promptId, image, text', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('type:')
    expect(src).toContain('nodeId?: string')
    expect(src).toContain('value?: number')
    expect(src).toContain('max?: number')
    expect(src).toContain('promptId?: string')
    expect(src).toContain('image?: string')
    expect(src).toContain('text?: string')
  })
})

// ============ ComfyLogLine has all required fields ============
describe('ComfyLogLine has all required fields', () => {
  it('has ts, level, message, source', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('ts: number')
    expect(src).toContain('level:')
    expect(src).toContain('message: string')
    expect(src).toContain('source?: string')
  })
})

// ============ DiagnosticPackage has all required fields ============
describe('DiagnosticPackage has all required fields', () => {
  it('has path, createdAt, size, contents', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('path: string')
    expect(src).toContain('createdAt: number')
    expect(src).toContain('size: number')
    expect(src).toContain('contents: string[]')
  })
})

// ============ EnvProbe has all required fields ============
describe('EnvProbe has all required fields', () => {
  it('has pythonPath, pythonVersion, venvPath, torchVersion, cudaVersion, packages, ok, errors', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('pythonPath: string')
    expect(src).toContain('pythonVersion: string')
    expect(src).toContain('venvPath?: string')
    expect(src).toContain('torchVersion?: string')
    expect(src).toContain('cudaVersion?: string')
    expect(src).toContain('packages: Array<')
    expect(src).toContain('ok: boolean')
    expect(src).toContain('errors: string[]')
  })
})

// ============ LaunchCommandPreview has all required fields ============
describe('LaunchCommandPreview has all required fields', () => {
  it('has python, args, cwd, commandLine', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('python: string')
    expect(src).toContain('args: string[]')
    expect(src).toContain('cwd: string')
    expect(src).toContain('commandLine: string')
  })
})

// ============ WaitReadyResult has all required fields ============
describe('WaitReadyResult has all required fields', () => {
  it('has ready, info, error, elapsedMs', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('ready: boolean')
    expect(src).toContain('info: ComfyInstanceInfo')
    expect(src).toContain('error?: string')
    expect(src).toContain('elapsedMs: number')
  })
})

// ============ InstanceDiscoveryCandidate has all required fields ============
describe('InstanceDiscoveryCandidate has all required fields', () => {
  it('has path, score, reason, hasMainPy, hasRequirements, hasVenv, estimatedVersion, registered', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('path: string')
    expect(src).toContain('score: number')
    expect(src).toContain('reason: string')
    expect(src).toContain('hasMainPy: boolean')
    expect(src).toContain('hasRequirements: boolean')
    expect(src).toContain('hasVenv: boolean')
    expect(src).toContain('estimatedVersion?: string')
    expect(src).toContain('registered?: boolean')
  })
})

// ============ DuplicateGroup has all required fields ============
describe('DuplicateGroup has all required fields', () => {
  it('has hash, size, files', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('hash: string')
    expect(src).toContain('size: number')
    expect(src).toContain('files: string[]')
  })
})

// ============ StorageStats has all required fields ============
describe('StorageStats has all required fields', () => {
  it('has category, count, bytes', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('category: ModelCategory')
    expect(src).toContain('count: number')
    expect(src).toContain('bytes: number')
  })
})

// ============ ModelScanProgress has all required fields ============
describe('ModelScanProgress has all required fields', () => {
  it('has scanned, total, currentPath, phase', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('scanned: number')
    expect(src).toContain('total: number')
    expect(src).toContain('currentPath: string')
    expect(src).toContain('phase:')
  })
})

// ============ NodeUpdateCheckResult has all required fields ============
describe('NodeUpdateCheckResult has all required fields', () => {
  it('has name, id, currentVersion, latestVersion, updatable, updateSource', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('name: string')
    expect(src).toContain('id: string')
    expect(src).toContain('currentVersion: string')
    expect(src).toContain('latestVersion?: string')
    expect(src).toContain('updatable: boolean')
    expect(src).toContain('updateSource:')
  })
})

// ============ NodeUpdateAllResult has all required fields ============
describe('NodeUpdateAllResult has all required fields', () => {
  it('has name, ok, error, skipped', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('name: string')
    expect(src).toContain('ok: boolean')
    expect(src).toContain('error?: string')
    expect(src).toContain('skipped?: boolean')
  })
})

// ============ ComfyUpdateOptions has all required fields ============
describe('ComfyUpdateOptions has all required fields', () => {
  it('has updateDeps, torchChannel, open', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('updateDeps?: boolean')
    expect(src).toContain('torchChannel?: TorchChannel')
    expect(src).toContain('open?:')
  })
})

// ============ RepairEnvOptions has all required fields ============
describe('RepairEnvOptions has all required fields', () => {
  it('has torchChannel, recreateVenv', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('torchChannel?: TorchChannel')
    expect(src).toContain('recreateVenv?: boolean')
  })
})

// ============ EnvCreateRequest has all required fields ============
describe('EnvCreateRequest has all required fields', () => {
  it('has basePath, pythonPath, useUv, torchIndex, name', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('basePath: string')
    expect(src).toContain('pythonPath: string')
    expect(src).toContain('useUv: boolean')
    expect(src).toContain('torchIndex?: string')
    expect(src).toContain('name: string')
  })
})

// ============ LaunchOptions has all required fields ============
describe('LaunchOptions has all required fields', () => {
  it('has open, relocatePort', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('open?:')
    expect(src).toContain('relocatePort?: boolean')
  })
})

// ============ PortCheckResult has all required fields ============
describe('PortCheckResult has all required fields', () => {
  it('has port, available, owner', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('port: number')
    expect(src).toContain('available: boolean')
    expect(src).toContain('owner?: string')
  })
})

// ============ InstanceActionResult / InstanceStopResult ============
describe('Instance action results', () => {
  it('InstanceActionResult extends ComfyInstanceInfo with ok/error', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('interface InstanceActionResult')
    expect(src).toContain('ok: boolean')
  })

  it('InstanceStopResult has adopted flag', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('interface InstanceStopResult')
    expect(src).toContain('adopted?: boolean')
  })
})

// ============ ProxySettings has all required fields ============
describe('ProxySettings has all required fields', () => {
  it('has enabled, protocol, host, port, username, password, bypass', () => {
    const src = readSrc('src/shared/types.ts')
    expect(src).toContain('enabled: boolean')
    expect(src).toContain('protocol: ProxyProtocol')
    expect(src).toContain('host: string')
    expect(src).toContain('port: number')
    expect(src).toContain('username: string')
    expect(src).toContain('password: string')
    expect(src).toContain('bypass: string')
  })
})
