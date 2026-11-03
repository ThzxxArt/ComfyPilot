/**
 * Semantic version of an installed ComfyUI tree.
 *
 * `git describe` is great when Git is available, but it is a subprocess and
 * it reports a commit-ish string. The launch gate and the instance card both
 * need a cheap, offline answer: ComfyUI ships `comfyui_version.py` (generated
 * from pyproject at build time), with `pyproject.toml` as the fallback for
 * source trees that predate that file.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export function readComfyVersion(installPath: string): string | undefined {
  if (!installPath) return undefined
  try {
    const versionFile = join(installPath, 'comfyui_version.py')
    if (existsSync(versionFile)) {
      const m = readFileSync(versionFile, 'utf-8').match(/^\s*__version__\s*=\s*["']([^"']+)["']/m)
      if (m) return m[1].trim()
    }
  } catch {
    /* unreadable file — fall through */
  }
  try {
    const pyproject = join(installPath, 'pyproject.toml')
    if (existsSync(pyproject)) {
      const m = readFileSync(pyproject, 'utf-8').match(/^\s*version\s*=\s*["']([^"']+)["']/m)
      if (m) return m[1].trim()
    }
  } catch {
    /* unreadable file — caller falls back to the install stamp */
  }
  return undefined
}
