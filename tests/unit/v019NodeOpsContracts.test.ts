/**
 * 0.1.9 contracts: node-op progress is terminal-style, never auto-closing,
 * and every batch/check/log event is wired end to end.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

describe('0.1.9 node-op modal contracts', () => {
  it('NodesView uses the new modal and never auto-closes it on terminal status', () => {
    const src = read('src/renderer/src/views/nodes/NodesView.vue')
    expect(src).toContain('NodeOpProgressModal')
    expect(src).not.toContain('ComfyUpdateProgressModal')
    // The old auto-close watch must never come back.
    expect(src).not.toMatch(/progress\.value\?\.status/)
    // The ONLY allowed programmatic close is the OP_BUSY path (nothing ran, so
    // showing the previous stream would be misleading). Terminal success or
    // failure must keep the log open.
    const closes = src.match(/showOpModal\.value = false/g) ?? []
    const busyGuarded = src.match(/OP_BUSY'[\s\S]{0,80}showOpModal\.value = false/g) ?? []
    expect(closes.length).toBeGreaterThan(0)
    expect(busyGuarded.length).toBe(closes.length)
  })

  it('MarketView uses the new modal and never auto-closes it', () => {
    const src = read('src/renderer/src/views/nodes/MarketView.vue')
    expect(src).toContain('NodeOpProgressModal')
    expect(src).not.toContain('ComfyUpdateProgressModal')
    expect(src).not.toMatch(/progress\.value\?\.status/)
  })

  it('NodeOpProgressModal keeps Close always enabled and supports cancellation', () => {
    const src = read('src/renderer/src/components/NodeOpProgressModal.vue')
    // Never disabled/discarded by terminal state.
    expect(src).toContain(':closable="true"')
    expect(src).toContain(':mask-closable="true"')
    expect(src).toContain('cancelNodeBatch')
    expect(src).toContain('cancelNodeOp')
    expect(src).toContain('batchCancelRemaining')
    expect(src).toContain('aggregatePercent')
    // Cancel must target the stream OWNER (kind-aware), never "active now".
    expect(src).toContain('streamOwnerId')
    expect(src).toContain('viewedNodeInstanceId')
    expect(src).toContain("progressKind.value === 'node-op'")
  })

  it('the ComfyUI-update modal is closable at any time and preserves streams (0.1.11)', () => {
    const src = read('src/renderer/src/components/ComfyUpdateProgressModal.vue')
    // Never locks the user out mid-update.
    expect(src).not.toContain(':closable="!updating"')
    expect(src).not.toContain(':mask-closable="!updating"')
    // Closing must not wipe any progress stream — the banner reopens the modal.
    expect(src).not.toContain('clearProgress()')
    // Both instance views own a "view progress" banner for the closable modal.
    expect(read('src/renderer/src/views/instances/InstancesView.vue')).toContain(
      'update.inProgress'
    )
    expect(read('src/renderer/src/views/instances/InstanceDetailView.vue')).toContain(
      'update.inProgress'
    )
  })

  it('NodesView keys check results by pack id (duplicate names are legal)', () => {
    const src = read('src/renderer/src/views/nodes/NodesView.vue')
    expect(src).toContain('checks.value[pack.id]')
    expect(src).not.toContain('checks.value[pack.name]')
    // Instance switch resets per-instance check state.
    expect(src).toContain('nodeCheck.value = null')
    expect(src).toContain('selectNodeOpInstance')
  })

  it('useComfyUpdate tracks node-op streams per instance', () => {
    const src = read('src/renderer/src/composables/useComfyUpdate.ts')
    expect(src).toContain('viewedNodeInstanceId')
    expect(src).toContain('nodeOpViews')
  })

  it('useComfyUpdate subscribes to batch, op-log and check-progress events', () => {
    const src = read('src/renderer/src/composables/useComfyUpdate.ts')
    expect(src).toContain('IPC_EVENTS.nodeUpdateBatch')
    expect(src).toContain('IPC_EVENTS.nodeOpLog')
    expect(src).toContain('IPC_EVENTS.nodeCheckProgress')
    expect(src).toContain('cancelNodeBatch')
  })

  it('main process broadcasts all node progress streams', () => {
    const src = read('src/main/index.ts')
    expect(src).toContain('IPC_EVENTS.nodeUpdateBatch')
    expect(src).toContain('IPC_EVENTS.nodeOpLog')
    expect(src).toContain('IPC_EVENTS.nodeCheckProgress')
  })

  it('nodePack streams git progress + batch context', () => {
    const src = read('src/main/services/nodePack.ts')
    expect(src).toContain('aggregatePercent')
    expect(src).toContain('cancelUpdateBatch')
    expect(src).toContain("emit('op-log'")
    expect(src).toContain("emit('update-batch'")
    expect(src).toContain("emit('check-progress'")
  })

  it('shell.reveal enforces a path allow-list', () => {
    const src = read('src/main/ipc/handlers.ts')
    expect(src).toContain('Blocked revealing path outside allowed areas')
    // The gate must be the per-segment normalizing resolver, not a lexical prefix.
    expect(src).toContain('resolveInsideAnyRoot')
  })

  it('e2e smoke boots the packaged bootstrap entry (not out/main/index.js)', () => {
    const src = read('tests/e2e/app-smoke.e2e.ts')
    // The constant must point at bootstrap.cjs AND the spawn must use the
    // bootstrap entry (relative form — 0.1.12: POSIX absolute paths break
    // Windows Electron under WSL interop) — pointing the constant at it while
    // spawning index.js was an empty check.
    expect(src).toContain("'bootstrap.cjs'")
    expect(src).toContain("'out/main/bootstrap.cjs'")
    expect(src).not.toMatch(/spawn\(\s*bin,\s*\[[^\]]*'index\.js'/)
  })

  it('output scan depth is wired settings → walk', () => {
    expect(read('src/main/services/p1p2.ts')).toContain('outputScanDepth')
    expect(read('src/shared/constants.ts')).toContain('outputScanDepth: 4')
    expect(read('src/main/services/db.ts')).toContain("'outputScanDepth'")
  })
})
