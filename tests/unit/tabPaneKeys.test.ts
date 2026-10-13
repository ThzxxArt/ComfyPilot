/**
 * NTabPane identity guard (0.1.11.1).
 *
 * naive-ui normalizes pane keys only when one is already set:
 *   `if (vNode.key !== void 0) vNode.key = name`
 * Keyless panes are patched positionally by Vue on every tab switch — the same
 * TabPane instance is reused for a different logical pane, which leaked the
 * terminal DOM/styles into the basic & profile panes (爸爸 2026-10-13: "终端
 * 跑到基本信息页面", "来回切换好多次才会变成终端样式"). Every pane must carry an
 * explicit key.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..', '..')

describe('NTabPane identity (0.1.11.1)', () => {
  it('every <NTabPane> declares a key', () => {
    const offenders: string[] = []
    let total = 0
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (ent.name.endsWith('.vue')) {
          const src = readFileSync(p, 'utf-8')
          for (const m of src.matchAll(/<NTabPane\b[\s\S]*?>/g)) {
            total += 1
            if (!/\bkey=/.test(m[0])) {
              offenders.push(`${ent.name}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`)
            }
          }
        }
      }
    }
    walk(join(root, 'src/renderer/src'))
    expect(total, 'NTabPane scan must find the known panes').toBeGreaterThanOrEqual(8)
    expect(offenders, `NTabPane without key: ${offenders.join(' | ')}`).toEqual([])
  })
})
