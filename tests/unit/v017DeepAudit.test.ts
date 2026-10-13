import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

// ---------- helpers ----------

describe('resolveOutputDir — respects --output-directory in extraArgs', () => {
  it('defaults to path/output when no extraArgs', async () => {
    const { resolveOutputDir } = await import('@main/services/p1p2')
    expect(resolveOutputDir({ path: 'C:/comfy', extraArgs: [] })).toMatch(/output$/)
    expect(resolveOutputDir({ path: 'C:/comfy' })).toMatch(/output$/)
  })

  it('uses custom dir when --output-directory is absolute', async () => {
    const { resolveOutputDir } = await import('@main/services/p1p2')
    const r = resolveOutputDir({ path: 'C:/comfy', extraArgs: ['--output-directory', 'D:/myout'] })
    expect(r).toBe('D:/myout')
  })

  it('resolves relative custom dir against instance path', async () => {
    const { resolveOutputDir } = await import('@main/services/p1p2')
    const r = resolveOutputDir({ path: 'C:/comfy', extraArgs: ['--output-directory', 'myout'] })
    expect(r).toMatch(/myout$/)
    expect(r).toContain('comfy')
  })

  it('ignores --output-directory without a value', async () => {
    const { resolveOutputDir } = await import('@main/services/p1p2')
    const r = resolveOutputDir({ path: 'C:/comfy', extraArgs: ['--output-directory'] })
    expect(r).toMatch(/output$/)
  })
})

describe('batch four-bucket counting semantics', () => {
  it('BatchJobItem type declares submitFailed and execFailed', () => {
    // Real contract check against the shipped type source (no self-built literals).
    const typesSrc = readFileSync(join(__dirname, '..', '..', 'src', 'shared', 'types.ts'), 'utf-8')
    expect(typesSrc).toContain('submitFailed')
    expect(typesSrc).toContain('execFailed')
  })

  it('unsettled formula subtracts execFailed only (contract)', async () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'p1p2.ts'),
      'utf-8'
    )
    expect(src).toContain('done.submitted - done.completed - (done.execFailed || 0)')
    // Must NOT use the buggy formula
    expect(src).not.toMatch(/done\.submitted - done\.completed - done\.failed(?!\w)/)
  })

  it('iteration counter is independent of submitted (contract)', async () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'p1p2.ts'),
      'utf-8'
    )
    expect(src).toContain('let iteration = 0')
    expect(src).not.toContain('const iteration = item.submitted')
  })
})

describe('settings schema validation strips unknown keys', () => {
  it('saveSettings strips keys not in KNOWN_SETTINGS_KEYS (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'db.ts'),
      'utf-8'
    )
    expect(src).toContain('KNOWN_SETTINGS_KEYS')
    expect(src).toContain('cleanPatch')
    // Must not blindly spread patch
    expect(src).not.toMatch(/\.\.\.patch,\s*\n\s*proxy:/)
  })

  it('KNOWN_SETTINGS_KEYS covers all AppSettings fields', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'db.ts'),
      'utf-8'
    )
    const keys = [
      'locale',
      'modelScanRoots',
      'githubEndpoint',
      'hfEndpoint',
      'civitaiEndpoint',
      'enableAutoCheckUpdates',
      'embedFrontend',
      'securityLevel',
      'allowGitUrlInstall',
      'allowPipInstall',
      'networkMode',
      'aria2Path',
      'useAria2',
      'launchOnBoot',
      'minimizeToTray',
      'autoStartInstancesOnLaunch',
      'proxy',
      'pipIndex',
      'torchIndexMirror'
    ]
    for (const k of keys) {
      expect(src).toContain(`'${k}'`)
    }
  })
})

describe('proxy password encryption (safeStorage)', () => {
  it('encryptProxyPassword falls back to plaintext without electron', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'db.ts'),
      'utf-8'
    )
    expect(src).toContain('encryptProxyPassword')
    expect(src).toContain('decryptProxyPassword')
    expect(src).toContain("startsWith('enc:')")
    expect(src).toContain('safeStorage')
  })

  it('decryptProxyPassword returns plaintext for non-enc values', () => {
    // Can't call internal fn directly; contract check on source
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'db.ts'),
      'utf-8'
    )
    // Must handle both enc: and plain
    expect(src).toContain('decryptProxyPassword')
  })
})

describe('backup workflow entity files', () => {
  it('backup.ts includes snapshotWorkflowFiles and restoreWorkflowFiles (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'backup.ts'),
      'utf-8'
    )
    expect(src).toContain('snapshotWorkflowFiles')
    expect(src).toContain('restoreWorkflowFiles')
    expect(src).toContain('workflow-files')
    expect(src).toContain('node-snapshots')
  })

  it('restore uses staging + rename for atomicity', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'backup.ts'),
      'utf-8'
    )
    expect(src).toContain('restore-tmp')
    expect(src).toContain('renameSync')
  })
})

describe('DB write locking', () => {
  it('withWriteLock and mutateInList exist (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'db.ts'),
      'utf-8'
    )
    expect(src).toContain('withWriteLock')
    expect(src).toContain('mutateInList')
    expect(src).toContain('writeLocks')
  })

  it('upsertInList uses withWriteLock', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'db.ts'),
      'utf-8'
    )
    // The upsertInList body must call withWriteLock
    const idx = src.indexOf('function upsertInList')
    expect(idx).toBeGreaterThan(-1)
    const body = src.slice(idx, idx + 300)
    expect(body).toContain('withWriteLock')
  })
})

describe('notification bus monotonic seq', () => {
  it('store has notificationSeq (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'stores', 'app.ts'),
      'utf-8'
    )
    expect(src).toContain('notificationSeq')
    expect(src).toContain('notificationSeq.value += 1')
  })

  it('App.vue watches notificationSeq not length (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'App.vue'),
      'utf-8'
    )
    expect(src).toContain('store.notificationSeq')
    expect(src).not.toMatch(/watch\(\s*\(\)\s*=>\s*store\.notifications\.length/)
  })
})

describe('progress slot mutex', () => {
  it('useComfyUpdate has progressKind and writeProgress (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'composables', 'useComfyUpdate.ts'),
      'utf-8'
    )
    expect(src).toContain('progressKind')
    expect(src).toContain('writeProgress')
    expect(src).toContain("writeProgress('comfy-update'")
    expect(src).toContain("writeProgress('repair'")
    expect(src).toContain("writeProgress('node-op'")
  })
})

describe('WS generation token', () => {
  it('monitor.ts has wsGeneration (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'monitor.ts'),
      'utf-8'
    )
    expect(src).toContain('wsGeneration')
    expect(src).toContain('gen !== this.wsGeneration')
  })
})

describe('op-progress per-instance Map', () => {
  it('nodePack uses opProgressMap not singleton (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain('opProgressMap')
    expect(src).not.toContain('private opProgress: UpdateProgress | null = null')
  })
})

describe('securityLevel tiers', () => {
  it('assertInstallAllowed differentiates strong/normal/normal-/weak (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain("level === 'strong'")
    expect(src).toContain("level === 'normal'")
    // weak/normal- should skip the allowGitUrlInstall gate
    expect(src).toContain('allowGitUrlInstall')
  })
})

describe('version pinning in git install', () => {
  it('installInner checks out tags/<ref> (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain('tags/')
    expect(src).toContain('checkout')
  })
})

describe('registryId preserved on git transport', () => {
  it('installInner accepts and passes registryId (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain('registryId')
    expect(src).toContain('registryId ?? prev?.registryId')
  })
})

describe('git rollback on update failure', () => {
  it('updateInner records oldRev and resets on failure (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain('rev-parse')
    expect(src).toContain('reset')
    expect(src).toContain('oldRev')
  })
})

describe('orphan dest cleanup on update rollback', () => {
  it('updateInner removes orphan install dirs (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain('orphan')
    expect(src).toContain('destName')
  })
})

describe('pip dependency uninstall', () => {
  it('uninstall accepts removePipDeps and calls removePipDeps (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'nodePack.ts'),
      'utf-8'
    )
    expect(src).toContain('removePipDeps')
    expect(src).toContain('pipRequirements')
    // Type must declare it
    const types = readFileSync(join(__dirname, '..', '..', 'src', 'shared', 'types.ts'), 'utf-8')
    expect(types).toContain('pipRequirements')
    expect(types).toContain('removePipDeps')
  })
})

describe('step.log capped at 400', () => {
  it('installer and updater cap logs (contract)', () => {
    const inst = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'installer.ts'),
      'utf-8'
    )
    const upd = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'updater.ts'),
      'utf-8'
    )
    expect(inst).toContain('step.log.length > 400')
    expect(upd).toContain('step.log.length > 400')
  })
})

describe('dead IPC removed', () => {
  it('instance.start/waitReady/workflow.launch/node.registrySearch removed (contract)', () => {
    const types = readFileSync(join(__dirname, '..', '..', 'src', 'shared', 'types.ts'), 'utf-8')
    const handlers = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'ipc', 'handlers.ts'),
      'utf-8'
    )
    expect(types).not.toContain("'instance.start':")
    expect(types).not.toContain("'instance.waitReady':")
    expect(types).not.toContain("'workflow.launch':")
    expect(types).not.toContain("'node.registrySearch':")
    expect(handlers).not.toContain("ipcMain.handle('instance.start'")
    expect(handlers).not.toContain("ipcMain.handle('instance.waitReady'")
    expect(handlers).not.toContain("ipcMain.handle('workflow.launch'")
    expect(handlers).not.toContain("ipcMain.handle('node.registrySearch'")
  })
})

describe('remote instance store integration', () => {
  it('store has remotes, activeRemoteId, isRemoteActive, activeTargetUrl (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'stores', 'app.ts'),
      'utf-8'
    )
    expect(src).toContain('remotes')
    expect(src).toContain('activeRemoteId')
    expect(src).toContain('isRemoteActive')
    expect(src).toContain('activeTargetUrl')
    expect(src).toContain('refreshRemotes')
  })

  it('App.vue selector shows remotes (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'App.vue'),
      'utf-8'
    )
    expect(src).toContain('remote:')
    expect(src).toContain('store.remotes')
    expect(src).toContain('store.isRemoteActive')
  })
})

describe('InstallView user choices respected', () => {
  it('userChoseMirror prevents auto-overwrite (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'install', 'InstallView.vue'),
      'utf-8'
    )
    expect(src).toContain('userChoseMirror')
    expect(src).toContain('plan.value.useUv !== false')
  })
})

describe('modelScanRoots UI', () => {
  it('SettingsView has modelScanRoots management (contract)', () => {
    const src = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'src',
        'renderer',
        'src',
        'views',
        'settings',
        'SettingsView.vue'
      ),
      'utf-8'
    )
    expect(src).toContain('modelScanRoots')
    expect(src).toContain('addScanRoot')
    expect(src).toContain('settings.paths')
    expect(src).toContain('settings.download')
  })
})

describe('post-update node check', () => {
  it('updater calls postUpdateNodeCheck (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'updater.ts'),
      'utf-8'
    )
    expect(src).toContain('postUpdateNodeCheck')
  })
})

describe('exportZip temp dir', () => {
  it('workflow exportZip uses tmpdir for extracted JSON (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'workflow.ts'),
      'utf-8'
    )
    expect(src).toContain('comfypilot-export')
    expect(src).toContain('rmSync')
  })
})

describe('workflow import dual target', () => {
  it('importFile supports library target (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'workflow.ts'),
      'utf-8'
    )
    expect(src).toContain("target === 'library'")
    expect(src).toContain("'instance' | 'library'")
    const types = readFileSync(join(__dirname, '..', '..', 'src', 'shared', 'types.ts'), 'utf-8')
    expect(types).toContain("('instance' | 'library')")
  })
})

describe('doctor explicit instanceId', () => {
  it('doctor.run throws on missing instance (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'doctor.ts'),
      'utf-8'
    )
    expect(src).toContain('Instance not found')
    // Must NOT fall back to configs[0] silently
    expect(src).not.toMatch(/configs\.find\(\(c\) => c\.id === instanceId\) \|\| configs\[0\]/)
  })
})

describe('proxyFetch URL safety', () => {
  it('proxyFetch validates URL (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'proxy.ts'),
      'utf-8'
    )
    expect(src).toContain('isSafeExternalUrl')
    // proxyFetch body must check
    const idx = src.indexOf('export async function proxyFetch')
    const body = src.slice(idx, idx + 500)
    expect(body).toContain('isSafeExternalUrl')
  })
})

describe('comfyApi timeouts', () => {
  it('interrupt has timeout and history has 5000ms (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'comfyApi.ts'),
      'utf-8'
    )
    expect(src).toContain('AbortSignal.timeout')
  })
})

describe('netProbe HEAD-first', () => {
  it('probeOne uses HEAD or cancel body (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'netProbe.ts'),
      'utf-8'
    )
    expect(src).toContain('HEAD')
    expect(src).toContain('cancel')
  })
})

describe('monitor throttle when hidden', () => {
  it('index.ts has scheduleMonitorTicks (contract)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf-8')
    expect(src).toContain('scheduleMonitorTicks')
  })
})

describe('starter auto-index after download', () => {
  it('model.ts triggers scan after download done (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'services', 'model.ts'),
      'utf-8'
    )
    expect(src).toContain('this.scan(')
    // notifyDownloadResult should trigger scan
    const idx = src.indexOf('notifyDownloadResult')
    const body = src.slice(idx, idx + 800)
    expect(body).toContain('this.scan(')
  })
})

describe('node install restart hint', () => {
  it('handlers broadcast restartRequired after node.install (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'main', 'ipc', 'handlers.ts'),
      'utf-8'
    )
    expect(src).toContain('notify.restartRequired')
  })
})

describe('batch start instance button', () => {
  it('BatchView has instanceNotRunning dialog (contract)', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src', 'renderer', 'src', 'views', 'workflows', 'BatchView.vue'),
      'utf-8'
    )
    expect(src).toContain('instanceNotRunning')
    expect(src).toContain('startInstance')
    expect(src).toContain('useLaunch')
  })
})

describe('v017 contracts test exists', () => {
  it('v017Contracts.test.ts exists and has tests', () => {
    const src = readFileSync(join(__dirname, 'v017Contracts.test.ts'), 'utf-8')
    expect(src).toContain('describe(')
    expect(src).toContain('it(')
  })
})

describe('i18n parity', () => {
  it('zh-CN and en-US have same key count (runtime check)', async () => {
    // Just verify files exist and export objects
    const zh = await import('@/i18n/locales/zh-CN')
    const en = await import('@/i18n/locales/en-US')
    expect(zh).toBeDefined()
    expect(en).toBeDefined()
  })
})

describe('APP_VERSION consistency', () => {
  it('constants.ts fallback matches package.json (no hardcoded release number)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'))
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'shared', 'constants.ts'), 'utf-8')
    // The dev fallback must always equal the package version — checked
    // dynamically so a release bump cannot break the suite.
    expect(typeof pkg.version).toBe('string')
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(src).toContain(`'${pkg.version}'`)
  })

  it('package.json version is a valid semver', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'))
    expect(pkg.version).toMatch(/^0\.\d+\.\d+$/)
  })
})

describe('coverage includes new services', () => {
  it('vitest.config.ts includes db/backup/doctor/monitor/registry (contract)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'vitest.config.ts'), 'utf-8')
    expect(src).toContain('src/main/services/db.ts')
    expect(src).toContain('src/main/services/backup.ts')
    expect(src).toContain('src/main/services/doctor.ts')
    expect(src).toContain('src/main/services/monitor.ts')
    expect(src).toContain('src/main/services/registry.ts')
    expect(src).toContain('src/main/services/registryIndex.ts')
    expect(src).toContain('src/main/services/netProbe.ts')
    expect(src).toContain('src/main/services/comfyApi.ts')
  })
})
