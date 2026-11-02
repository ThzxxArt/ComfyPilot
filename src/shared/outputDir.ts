/**
 * Resolve an instance's output directory (0.2.0).
 *
 * Both the main-process scanner and the renderer must agree. The directory can
 * come from structured `launchProfile.outputDirectory` OR free-form
 * `--output-directory` (including `--output-directory=...`). Relative paths
 * resolve against the instance root. Pure string logic — safe in the renderer.
 */

export interface OutputDirSource {
  path: string
  extraArgs?: string[]
  launchProfile?: { outputDirectory?: string }
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`
}

export function resolveOutputDir(inst: OutputDirSource): string {
  const args = [
    ...(inst.launchProfile?.outputDirectory
      ? ['--output-directory', inst.launchProfile.outputDirectory]
      : []),
    ...(inst.extraArgs || [])
  ]
  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] || '')
    if (token === '--output-directory') {
      const value = args[i + 1]
      if (value) return resolveValue(inst.path, value)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0 && token.slice(0, eq) === '--output-directory') {
      const value = token.slice(eq + 1)
      if (value) return resolveValue(inst.path, value)
    }
  }
  return joinPath(inst.path, 'output')
}

function resolveValue(root: string, value: string): string {
  const raw = String(value)
  return isAbsolutePath(raw) ? raw : joinPath(root, raw)
}
