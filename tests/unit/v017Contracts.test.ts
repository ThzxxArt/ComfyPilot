import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..', '..')

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

describe('v0.1.7 collaboration & data contracts', () => {
  it('notification bus uses monotonic seq, not array length', () => {
    const store = readSrc('src/renderer/src/stores/app.ts')
    expect(store).toContain('notificationSeq')
    // pushNotification must bump the seq
    expect(store).toMatch(/notificationSeq\.value\s*\+=\s*1/)
    // The array is still capped for history
    expect(store).toContain('slice(-19)')
  })

  it('App.vue watches notificationSeq, not notifications.length', () => {
    const app = readSrc('src/renderer/src/App.vue')
    expect(app).toContain('store.notificationSeq')
    expect(app).not.toMatch(/watch\(\s*\(\)\s*=>\s*store\.notifications\.length/)
  })

  it('progress slot mutex prevents concurrent overwrite', () => {
    const uc = readSrc('src/renderer/src/composables/useComfyUpdate.ts')
    expect(uc).toContain('progressKind')
    expect(uc).toContain('writeProgress')
    // Three event streams must go through writeProgress
    expect(uc).toContain("writeProgress('comfy-update'")
    expect(uc).toContain("writeProgress('repair'")
    expect(uc).toContain("writeProgress('node-op'")
  })

  it('batch unsettled uses execFailed, not total failed', () => {
    const p1p2 = readSrc('src/main/services/p1p2.ts')
    // CRITICAL: unsettled must subtract execFailed only
    expect(p1p2).toContain('done.submitted - done.completed - (done.execFailed || 0)')
    // Must NOT use the old formula
    expect(p1p2).not.toContain('done.submitted - done.completed - done.failed')
  })

  it('batch tracks submitFailed and execFailed separately', () => {
    const types = readSrc('src/shared/types.ts')
    expect(types).toContain('submitFailed: number')
    expect(types).toContain('execFailed: number')
    const p1p2 = readSrc('src/main/services/p1p2.ts')
    expect(p1p2).toContain('item.submitFailed += 1')
    expect(p1p2).toContain('item.execFailed += 1')
  })

  it('batch iteration counter is independent of submitted', () => {
    const p1p2 = readSrc('src/main/services/p1p2.ts')
    // Must NOT use item.submitted as iteration seed source
    expect(p1p2).not.toContain('const iteration = item.submitted')
    expect(p1p2).toContain('let iteration = 0')
  })

  it('op-progress uses per-instance Map, not a singleton', () => {
    const np = readSrc('src/main/services/nodePack.ts')
    expect(np).toContain('opProgressMap')
    expect(np).toContain('private opProgressMap = new Map')
    // Must NOT have the old singleton
    expect(np).not.toContain('private opProgress: UpdateProgress | null = null')
  })

  it('WS connection uses generation token', () => {
    const mon = readSrc('src/main/services/monitor.ts')
    expect(mon).toContain('wsGeneration')
    expect(mon).toContain('if (gen !== this.wsGeneration) return')
  })

  it('backup includes workflow entity files', () => {
    const bk = readSrc('src/main/services/backup.ts')
    expect(bk).toContain('workflow-files')
    expect(bk).toContain('snapshotWorkflowFiles')
    expect(bk).toContain('restoreWorkflowFiles')
  })

  it('DB writes are serialised per-file', () => {
    const db = readSrc('src/main/services/db.ts')
    expect(db).toContain('withWriteLock')
    expect(db).toContain('mutateInList')
  })

  it('extra_model_paths auto-discovers when no path given', () => {
    const model = readSrc('src/main/services/model.ts')
    expect(model).toContain('extra_model_paths.yaml')
    expect(model).toContain('loadInstanceConfigsSafe')
  })

  it('workflow import supports library target', () => {
    const wf = readSrc('src/main/services/workflow.ts')
    expect(wf).toContain("'library'")
    expect(wf).toContain("target === 'library'")
    const types = readSrc('src/shared/types.ts')
    expect(types).toContain("('instance' | 'library')")
  })

  it('dead IPC channels are removed', () => {
    const types = readSrc('src/shared/types.ts')
    const handlers = readSrc('src/main/ipc/handlers.ts')
    // These must NOT exist in the IPC map or handlers
    expect(types).not.toContain("'instance.start':")
    expect(types).not.toContain("'instance.waitReady':")
    expect(types).not.toContain("'workflow.launch':")
    expect(types).not.toContain("'node.registrySearch':")
    expect(handlers).not.toContain("ipcMain.handle('instance.start'")
    expect(handlers).not.toContain("ipcMain.handle('instance.waitReady'")
    expect(handlers).not.toContain("ipcMain.handle('workflow.launch'")
    expect(handlers).not.toContain("ipcMain.handle('node.registrySearch'")
  })

  it('NodesView watches instanceSwitchTick', () => {
    const nv = readSrc('src/renderer/src/views/nodes/NodesView.vue')
    expect(nv).toContain('instanceSwitchTick')
  })

  it('step.log is capped at 400 lines in installer and updater', () => {
    const inst = readSrc('src/main/services/installer.ts')
    const upd = readSrc('src/main/services/updater.ts')
    expect(inst).toContain('step.log.length > 400')
    expect(upd).toContain('step.log.length > 400')
  })

  it('InstallView respects user mirror choice and useUv toggle', () => {
    const iv = readSrc('src/renderer/src/views/install/InstallView.vue')
    expect(iv).toContain('userChoseMirror')
    expect(iv).toContain('plan.value.useUv !== false')
    // Must NOT hardcode useUv: true in startFullAuto
    expect(iv).not.toMatch(/useUv:\s*true,\s*\n\s*autoStart:\s*true/)
  })

  it('modelScanRoots has UI write access in SettingsView', () => {
    const sv = readSrc('src/renderer/src/views/settings/SettingsView.vue')
    expect(sv).toContain('modelScanRoots')
    expect(sv).toContain('addScanRoot')
  })

  it('remote instances are in the app store', () => {
    const store = readSrc('src/renderer/src/stores/app.ts')
    expect(store).toContain('remotes')
    expect(store).toContain('activeRemoteId')
    expect(store).toContain('isRemoteActive')
    expect(store).toContain('activeTargetUrl')
    expect(store).toContain('refreshRemotes')
  })

  it('remote appears in App.vue instance selector', () => {
    const app = readSrc('src/renderer/src/App.vue')
    expect(app).toContain('remote:')
    expect(app).toContain('store.remotes')
    expect(app).toContain('store.isRemoteActive')
  })

  it('coverage includes db, backup, doctor, monitor, registry', () => {
    const cfg = readSrc('vitest.config.ts')
    expect(cfg).toContain('src/main/services/db.ts')
    expect(cfg).toContain('src/main/services/backup.ts')
    expect(cfg).toContain('src/main/services/doctor.ts')
    expect(cfg).toContain('src/main/services/monitor.ts')
    expect(cfg).toContain('src/main/services/registry.ts')
  })
})
