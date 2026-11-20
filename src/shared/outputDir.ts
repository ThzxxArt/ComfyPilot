/**
 * Resolve an instance's effective output directory (0.2.5 WP1).
 *
 * The output root follows the FINAL argv, so `--base-directory`,
 * `--output-directory` and free-text `--output-directory=...` all agree with
 * what ComfyUI actually writes. Relative paths resolve against the instance
 * root (ComfyUI's cwd). Pure string logic — safe in the renderer.
 */
import type { LaunchProfile } from './types'
import { resolveEffectiveDirs } from './instanceLayout'

export interface OutputDirSource {
  path: string
  port?: number
  listen?: string
  argTemplateId?: string
  extraArgs?: string[]
  launchProfile?: Pick<LaunchProfile, 'baseDirectory' | 'outputDirectory'>
}

export function resolveOutputDir(inst: OutputDirSource): string {
  return resolveEffectiveDirs({
    path: inst.path,
    port: inst.port,
    listen: inst.listen,
    argTemplateId: inst.argTemplateId || 'default',
    extraArgs: inst.extraArgs,
    launchProfile: inst.launchProfile
  }).output
}
