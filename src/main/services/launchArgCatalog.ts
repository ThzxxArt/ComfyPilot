/**
 * Dynamic launch-argument catalogue (0.2.0).
 *
 * Reads the instance's own `comfy/cli_args.py` so a newer ComfyUI exposes flags
 * the static table does not know yet. Never guesses: if the file is missing or
 * unreadable, the caller falls back to the static catalogue.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { staticLaunchFlags } from '@shared/launchArgs'
import { resolveReadTarget } from './target'

export function launchArgCatalog(instanceId?: string): string[] {
  const config = resolveReadTarget(instanceId)
  const flags = new Set<string>(staticLaunchFlags())
  if (config?.path) {
    const file = join(config.path, 'comfy', 'cli_args.py')
    if (existsSync(file)) {
      try {
        const text = readFileSync(file, 'utf-8')
        const re = /add_argument\(\s*['"](--[a-zA-Z0-9][a-zA-Z0-9-]*)['"]/g
        let m: RegExpExecArray | null
        while ((m = re.exec(text))) flags.add(m[1])
      } catch {
        /* fall back to static */
      }
    }
  }
  return [...flags].sort()
}
