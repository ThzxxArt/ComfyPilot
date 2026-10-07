import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..', '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf-8')
}

describe('IPC contract parity', () => {
  const typesSrc = read('src/shared/types.ts')
  const mapBlock = typesSrc.match(/export type IpcChannelMap = \{([\s\S]*?)\n\}/)
  expect(mapBlock, 'IpcChannelMap must exist').toBeTruthy()
  const channels = [...(mapBlock?.[1] || '').matchAll(/'([\w.]+)'\s*:/g)].map((m) => m[1])

  it('IpcChannelMap is non-empty', () => {
    expect(channels.length).toBeGreaterThan(50)
  })

  it('every IpcChannelMap key has an ipcMain.handle registration', () => {
    const handlersSrc = read('src/main/ipc/handlers.ts')
    const registered = new Set(
      [...handlersSrc.matchAll(/ipcMain\.handle\(\s*'([\w.]+)'/g)].map((m) => m[1])
    )
    const missing = channels.filter((c) => !registered.has(c))
    expect(missing, `handlers.ts missing: ${missing.join(', ')}`).toEqual([])
  })

  it('handlers register only known channels (no drift the other way)', () => {
    const handlersSrc = read('src/main/ipc/handlers.ts')
    const registered = [...handlersSrc.matchAll(/ipcMain\.handle\(\s*'([\w.]+)'/g)].map((m) => m[1])
    const known = new Set(channels)
    const extra = registered.filter((c) => !known.has(c))
    expect(extra, `handlers.ts unknown channels: ${extra.join(', ')}`).toEqual([])
  })

  it('every channel invoked from the renderer exists in IpcChannelMap', () => {
    const known = new Set(channels)
    const missing: string[] = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name)
        if (ent.isDirectory()) walk(p)
        else if (/\.(vue|ts)$/.test(ent.name)) {
          const src = readFileSync(p, 'utf-8')
          for (const m of src.matchAll(/\bipc\(\s*'([\w.]+)'/g)) {
            if (!known.has(m[1])) missing.push(`${m[1]} (${ent.name})`)
          }
        }
      }
    }
    walk(join(root, 'src/renderer/src'))
    expect(missing, `renderer invokes unknown channels: ${missing.join(', ')}`).toEqual([])
  })

  it('IPC_EVENTS used by broadcast all appear in preload allowlist source', () => {
    const preload = read('src/preload/index.ts')
    expect(preload).toContain('ALLOWED_EVENTS')
    expect(preload).toContain('Object.values(IPC_EVENTS)')
  })

  it('bootstrap.cjs is staged into out/main by postbuild', () => {
    expect(existsSync(join(root, 'scripts/postbuild.cjs'))).toBe(true)
    const pkg = JSON.parse(read('package.json')) as { scripts: { build: string } }
    expect(pkg.scripts.build).toContain('postbuild.cjs')
  })
})
