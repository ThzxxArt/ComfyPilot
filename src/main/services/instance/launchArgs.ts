import { existsSync } from 'fs'
import { join } from 'path'
import type { ComfyInstanceConfig, LaunchCommandPreview, LaunchProfile } from '@shared/types'
import { LAUNCH_TEMPLATES } from '@shared/constants'
import { renderLaunchProfile, validateLaunchArgs, warnLaunchArgs } from '@shared/launchArgs'
import { parseArgv, splitFlagArg } from '@shared/argv'
import { capabilityService } from '../capabilities'
import { loadInstanceConfigs } from '../db'
import type { InstanceServiceContext, RuntimeEntry } from './types'

/** Drop undefined/default-only fields so instances.jsonc stays readable. */
export function normalizeLaunchProfile(profile?: LaunchProfile): LaunchProfile | undefined {
  if (!profile) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(profile)) {
    if (value === undefined || value === null || value === '') continue
    if (value === 'default') continue
    // Explicit `false` is KEPT: for toggle fields (e.g. disableAutoLaunch) it
    // is a real user decision, distinct from "unset".
    out[key] = value
  }
  return Object.keys(out).length ? (out as LaunchProfile) : undefined
}

/** Quote a single argv for display in a command-line preview (exported for tests). */
export function quoteCommandLineArg(s: string): string {
  return /[\s"&|<>^%]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/** Escape a value for a Windows .bat line (cmd.exe). Not for display. */
export function escapeForBat(value: string): string {
  // % must become %% before any quoting; then escape cmd metacharacters.
  let s = String(value).replace(/%/g, '%%')
  // Double quotes inside a quoted arg: cmd uses "" doubling, not backslash.
  s = s.replace(/"/g, '""')
  // Escape remaining metacharacters that survive inside quotes poorly.
  s = s.replace(/([&|<>^!])/g, '^$1')
  return `"${s}"`
}

/** Escape a value for a POSIX shell single-quoted string. */
export function escapeForSh(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function buildArgs(config: ComfyInstanceConfig): string[] {
  const args = [join(config.path, 'main.py'), '--port', String(config.port || 8188)]
  const template = LAUNCH_TEMPLATES.find((t) => t.id === config.argTemplateId)
  const templateArgs = template?.args || []
  // Dedupe `--listen`: the lan template brings its own 0.0.0.0 — pushing the
  // configured listen first made the printed command line ambiguous.
  if (!templateArgs.includes('--listen')) args.push('--listen', config.listen || '127.0.0.1')
  args.push(...templateArgs)
  // Structured tuning renders before free-text extraArgs so an explicit
  // override in extraArgs still wins by being last.
  const profileArgs = renderLaunchProfile(config.launchProfile)
  args.push(...profileArgs)
  const extra = Array.isArray(config.extraArgs)
    ? config.extraArgs
    : parseArgv(String(config.extraArgs || '')).tokens
  const allDeclared = [...templateArgs, ...profileArgs, ...extra]
  const hasFlag = (flag: string): boolean => allDeclared.some((a) => splitFlagArg(a).flag === flag)
  // Explicitly load the instance's extra_model_paths.yaml when it exists, so
  // a custom cwd / --base-directory can never silently lose the model paths.
  const yamlPath = join(config.path, 'extra_model_paths.yaml')
  if (!hasFlag('--extra-model-paths-config') && existsSync(yamlPath)) {
    args.push('--extra-model-paths-config', yamlPath)
  }
  // Default: ComfyUI must not open a browser tab on its own — ComfyPilot owns
  // window/browser opening. Skipped when the user declared either side of the
  // flag explicitly (template / profile / free text) and when the profile
  // explicitly opted out (disableAutoLaunch=false keeps ComfyUI's own default).
  const autoLaunchDeclared = hasFlag('--auto-launch') || hasFlag('--disable-auto-launch')
  if (!autoLaunchDeclared && config.launchProfile?.disableAutoLaunch !== false) {
    args.push('--disable-auto-launch')
  }
  if (extra.length) args.push(...extra)
  return args
}

/**
 * Throw codedError-style LAUNCH_ARGS_INVALID when the final argv contains
 * argparse-fatal conflicts. Shared by the spawn path and the port-relocation
 * path (which must validate before persisting the new port).
 */
export function assertLaunchArgsValid(
  ctx: InstanceServiceContext,
  rt: RuntimeEntry,
  args: string[]
): void {
  const argErrors = validateLaunchArgs(args)
  if (!argErrors.length) return
  const err = new Error(
    `Invalid launch arguments: ${argErrors
      .map((e) => (e.flag ? `${e.code} (${e.flag})` : e.code))
      .join(', ')}`
  ) as Error & { code?: string }
  err.code = 'LAUNCH_ARGS_INVALID'
  rt.lastError = err.message
  rt.status = 'error'
  ctx.pushLog(rt, 'error', err.message)
  ctx.emitStatus(rt)
  throw err
}

export function previewLaunch(ctx: InstanceServiceContext, id: string): LaunchCommandPreview {
  const config = loadInstanceConfigs().find((c) => c.id === id)
  if (!config) throw new Error(`Instance not found: ${id}`)
  const python = ctx.resolvePython(config)
  const args = ctx.buildArgs(config)
  const commandLine = [python, ...args].map(quoteCommandLineArg).join(' ')
  return {
    python,
    args,
    cwd: config.path,
    commandLine,
    validationErrors: validateLaunchArgs(args),
    validationWarnings: warnLaunchArgs(args, {
      version: capabilityService.knownVersionForInstance(config.id)
    })
  }
}

/**
 * Write a runnable launch script (.bat / .sh) for an instance.
 * Uses the same resolved command as previewLaunch so what you see is what runs.
 */
export async function exportLaunchScript(
  ctx: InstanceServiceContext,
  id: string,
  opts?: { dir?: string; kind?: 'bat' | 'sh' }
): Promise<{ path: string }> {
  const preview = ctx.previewLaunch(id)
  const kind = opts?.kind || (process.platform === 'win32' ? 'bat' : 'sh')
  const ext = kind === 'bat' ? '.bat' : '.sh'
  const configs = loadInstanceConfigs()
  const config = configs.find((c) => c.id === id)
  const baseName = `launch-${(config?.name || 'comfyui').replace(/[^\w.-]+/g, '_').slice(0, 40)}`
  const { dialog } = await import('electron')
  const { writeFileSync, mkdirSync } = await import('fs')
  const { dirname, join } = await import('path')

  let target: string | undefined = opts?.dir ? join(opts.dir, baseName + ext) : undefined
  if (!target) {
    const win = await dialog.showSaveDialog({
      title: 'Export launch script',
      defaultPath: join(preview.cwd, baseName + ext),
      filters:
        kind === 'bat'
          ? [{ name: 'Batch', extensions: ['bat'] }]
          : [{ name: 'Shell', extensions: ['sh'] }]
    })
    if (win.canceled || !win.filePath) throw new Error('Cancelled')
    target = win.filePath
  }
  mkdirSync(dirname(target), { recursive: true })
  // Platform-correct escaping — quoteCommandLineArg is display-only and unsafe here.
  const body =
    kind === 'bat'
      ? `@echo off\r\nREM Generated by ComfyPilot\r\ncd /d ${escapeForBat(preview.cwd)}\r\n${escapeForBat(preview.python)} ${preview.args.map(escapeForBat).join(' ')}\r\n`
      : `#!/usr/bin/env bash\n# Generated by ComfyPilot\ncd ${escapeForSh(preview.cwd)}\n${escapeForSh(preview.python)} ${preview.args.map(escapeForSh).join(' ')}\n`
  writeFileSync(target, body, 'utf-8')
  return { path: target }
}
