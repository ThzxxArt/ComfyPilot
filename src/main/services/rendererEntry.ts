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
  if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) {
    return true
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
