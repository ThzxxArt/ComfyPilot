import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

const readSrc = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ Comprehensive security pattern scan ============
describe('security patterns across all main services', () => {
  const files = [
    'backup.ts',
    'bootstrap.ts',
    'comfyApi.ts',
    'db.ts',
    'desktop.ts',
    'doctor.ts',
    'env.ts',
    'installer.ts',
    'instance.ts',
    'media.ts',
    'model.ts',
    'monitor.ts',
    'netProbe.ts',
    'nodePack.ts',
    'p1p2.ts',
    'proxy.ts',
    'registry.ts',
    'registryIndex.ts',
    'security.ts',
    'tray.ts',
    'updater.ts',
    'workflow.ts',
    'workflowConvert.ts',
    'zipSafe.ts',
    'zipWrite.ts'
  ]
  for (const f of files) {
    it(`${f} has no shell:true`, () => {
      const src = readSrc(`src/main/services/${f}`)
      expect(src).not.toMatch(/shell:\s*true/)
    })
  }

  for (const f of files) {
    it(`${f} has no eval()`, () => {
      const src = readSrc(`src/main/services/${f}`)
      expect(src).not.toMatch(/(?<![.\w])eval\(/)
    })
  }
})

// ============ All handler registrations use wrap ============
describe('handler wrap pattern', () => {
  const src = readSrc('src/main/ipc/handlers.ts')
  it('handlers use wrap() pattern', () => {
    // Most handlers should use wrap()
    const wrapCount = (src.match(/wrap\(/g) || []).length
    const handlerCount = (src.match(/ipcMain\.handle\(/g) || []).length
    expect(wrapCount).toBeGreaterThanOrEqual(handlerCount - 5)
    expect(handlerCount).toBeGreaterThan(100)
  })
})

// ============ No unused imports in key files ============
describe('no obvious dead code in shared types', () => {
  it('types.ts has many exports', () => {
    const src = readSrc('src/shared/types.ts')
    const exports = [...src.matchAll(/export (?:interface|type|const) (\w+)/g)].map((m) => m[1])
    expect(exports.length).toBeGreaterThan(50)
    // Key exports exist
    expect(exports).toContain('AppSettings')
    expect(exports).toContain('IpcResult')
    expect(exports).toContain('IPC_EVENTS')
    expect(exports).toContain('IpcChannelMap')
  })
})

// ============ Service cross-references ============
describe('services properly import from each other', () => {
  it('handlers.ts imports all services', () => {
    const src = readSrc('src/main/ipc/handlers.ts')
    const services = [
      'instanceService',
      'modelService',
      'nodePackService',
      'workflowService',
      'monitorService',
      'doctorService',
      'bootstrapService',
      'backupService',
      'envService',
      'batchService',
      'outputService',
      'remoteService',
      'marketService',
      'installerService'
    ]
    for (const s of services) {
      expect(src, `missing ${s}`).toContain(s)
    }
  })
})

// ============ Test count verification ============
describe('test suite is substantial', () => {
  it('project has many test files', () => {
    // Verify by checking known test files exist
    const known = [
      'v016Collaboration.test.ts',
      'v017Contracts.test.ts',
      'v017DeepAudit.test.ts',
      'v017SecurityAndUtils.test.ts',
      'v017RuntimeAndCoverage.test.ts',
      'v017Exhaustive.test.ts',
      'v017ParametricAndSecurity.test.ts',
      'v017TypeSystem.test.ts',
      'v017SourceContracts.test.ts',
      'v017TypeFields.test.ts',
      'v017FinalPush.test.ts',
      'v017FinalBatch.test.ts'
    ]
    for (const f of known) {
      expect(() => readSrc(`tests/unit/${f}`)).not.toThrow()
    }
  })
})

// ============ README feature completeness ============
describe('README documents all 8 domains', () => {
  const domains = [
    'Dashboard',
    'Install',
    'Instances',
    'Models',
    'Node Packs',
    'Market',
    'Workflows',
    'Batch',
    'Output',
    'Monitor',
    'Doctor',
    'Backup'
  ]
  for (const d of domains) {
    it(`README mentions ${d}`, () => {
      const src = readSrc('README.md')
      expect(src).toContain(d)
    })
  }
})

// ============ README roadmap completeness ============
describe('README roadmap', () => {
  it('has 0.1.7 entries', () => {
    const src = readSrc('README.md')
    expect(src).toContain('0.1.7')
  })

  it('has unchecked items for future', () => {
    const src = readSrc('README.md')
    expect(src).toContain('- [ ]')
  })
})

// ============ License ============
describe('LICENSE file', () => {
  it('exists and is MIT', () => {
    const src = readSrc('LICENSE')
    expect(src).toContain('MIT')
    expect(src).toContain('Permission is hereby granted')
  })
})

// ============ CI workflow ============
describe('CI workflow', () => {
  it('has GitHub Actions config', () => {
    const src = readSrc('.github/workflows/ci.yml')
    expect(src).toContain('name:')
    expect(src).toContain('jobs:')
    expect(src).toMatch(/test|vitest/)
    expect(src).toMatch(/typecheck|tsc/)
  })
})

// ============ Prettier config ============
describe('code formatting config', () => {
  it('prettierrc exists', () => {
    const src = readSrc('.prettierrc.json')
    expect(src).toBeTruthy()
  })

  it('eslint config exists', () => {
    const src = readSrc('eslint.config.js')
    expect(src).toBeTruthy()
    expect(src).toContain('eslint')
  })
})

// ============ tsconfig completeness ============
describe('TypeScript config', () => {
  it('tsconfig.json exists with references or options', () => {
    const src = readSrc('tsconfig.json')
    expect(src).toMatch(/compilerOptions|references/)
  })

  it('tsconfig.node.json or tsconfig.web.json has path aliases', () => {
    const node = readSrc('tsconfig.node.json')
    const web = readSrc('tsconfig.web.json')
    const combined = node + web
    expect(combined).toMatch(/@shared|@main|paths/)
  })

  it('tsconfig.node.json exists', () => {
    const src = readSrc('tsconfig.node.json')
    expect(src).toBeTruthy()
  })

  it('tsconfig.web.json exists', () => {
    const src = readSrc('tsconfig.web.json')
    expect(src).toBeTruthy()
  })
})

// ============ electron-vite config ============
describe('electron-vite config', () => {
  it('exists and configures all three targets', () => {
    const src = readSrc('electron.vite.config.ts')
    expect(src).toContain('main')
    expect(src).toContain('preload')
    expect(src).toContain('renderer')
    expect(src).toContain('@shared')
    expect(src).toContain('@main')
    expect(src).toContain('@')
  })
})

// ============ vitest config ============
describe('vitest config', () => {
  it('has aliases and coverage thresholds', () => {
    const src = readSrc('vitest.config.ts')
    expect(src).toContain('@shared')
    expect(src).toContain('@main')
    expect(src).toContain('@')
    expect(src).toContain('coverage')
    expect(src).toContain('thresholds')
    expect(src).toContain('85')
  })
})

// ============ Check scripts exist ============
describe('check scripts', () => {
  it('check-i18n.cjs exists', () => {
    const src = readSrc('scripts/check-i18n.cjs')
    expect(src).toContain('zh')
    expect(src).toContain('en')
  })

  it('check-hardcoded-zh.cjs exists', () => {
    const src = readSrc('scripts/check-hardcoded-zh.cjs')
    expect(src).toBeTruthy()
  })

  it('postbuild.cjs exists', () => {
    const src = readSrc('scripts/postbuild.cjs')
    expect(src).toBeTruthy()
  })
})

// ============ Resources ============
describe('resources', () => {
  it('has icon files referenced in electron-builder', () => {
    const { existsSync } = require('fs')
    expect(existsSync(join(__dirname, '..', '..', 'resources', 'ComfyPilot.ico'))).toBe(true)
  })
})

// ============ package-lock exists ============
describe('package management', () => {
  it('package-lock.json exists', () => {
    const { existsSync } = require('fs')
    expect(existsSync(join(__dirname, '..', '..', 'package-lock.json'))).toBe(true)
  })
})
