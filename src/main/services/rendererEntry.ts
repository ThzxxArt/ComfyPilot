/**
 * 0.2.0: the single definition of "this URL is our own renderer".
 *
 * It is used both for navigation guards (`will-navigate`) and for the IPC
 * sender-frame check. Keeping one implementation prevents the IPC gate from
 * drifting away from the window's real entry point.
 */
import { existsSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { safeResolveUnder } from './security'

export function isOwnRendererUrl(url: string): boolean {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) {
    // 0.2.5 WP10 / S5: prefix matching let `http://localhost:5173.evil` and
    // `http://localhost:5173@evil` inherit the preload bridge. Compare the
    // exact origin+pathname, and never accept userinfo.
    try {
      const expected = new URL(dev)
      const actual = new URL(url)
      if (actual.username || actual.password) return false
      if (actual.origin !== expected.origin) return false
      const basePath = expected.pathname.replace(/\/+$/, '') || '/'
      const actualPath = actual.pathname
      if (basePath === '/') return true
      if (actualPath === basePath) return true
      return actualPath.startsWith(`${basePath}/`)
    } catch {
      return false
    }
  }
  if (!url.startsWith('file:')) return false
  try {
    const target = resolve(fileURLToPath(url))
    const htmlReal = join(process.resourcesPath || '', 'renderer', 'index.html')
    const htmlAsar = join(__dirname, '../renderer/index.html')
    const entry = resolve(existsSync(htmlReal) ? htmlReal : htmlAsar)
    if (target === entry) return true
    const rendererDir = dirname(entry)
    const rel = relative(rendererDir, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
    return Boolean(safeResolveUnder(rendererDir, rel))
  } catch {
    return false
  }
}
