import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import type { NodeDepsAudit, NodePackIssue, NodePackRecord, PipOpResult } from '@shared/types'
import type { PipRequirement } from '@shared/pipVersion'
import {
  auditPackRequirements,
  installedPackages,
  pipCheck,
  requirementsForPack
} from '../depsAudit'
import { acquireEnvLock } from '../envLock'
import { loadSettings } from '../db'
import { normalizeForCompare } from '../security'
import type { NodePackHost } from './host'
import {
  codedError,
  execFileAsync,
  parseRequirementNames,
  resolveInstanceConfig,
  resolveInstancePython
} from './common'

/**
 * Residual pip requirement names recorded for a pack. Empty when the pack
 * ships no requirements.txt. Used by the uninstall dialog to offer an
 * optional pip cleanup.
 */
export function pipDeps(this: NodePackHost, idOrName: string, instanceId?: string): string[] {
  const packs = this.list(instanceId)
  const pack = packs.find((p) => p.id === idOrName || p.name === idOrName)
  if (!pack) return []
  if (pack.pipRequirements?.length) return [...pack.pipRequirements]
  // Fall back to reading requirements.txt for records saved before the
  // pipRequirements field existed.
  try {
    if (pack.path) {
      const reqFile = join(pack.path, 'requirements.txt')
      if (existsSync(reqFile)) return parseRequirementNames(readFileSync(reqFile, 'utf-8'))
    }
  } catch {
    /* ignore */
  }
  return []
}

/**
 * Dependency audit (0.1.12 WP5): every enabled pack's requirements.txt vs
 * the instance environment's installed package list.
 * - Names always checked; version specifiers via PEP 440-lite rules.
 * - Installed list: `uv pip list` first (works without pip), then
 *   `python -m pip list`. When neither works → ok:false + pipAvailable:false.
 * - Honest scope: only DECLARED requirements (optional deps like
 *   sageattention are not in requirements.txt — the runtime diagnosis card
 *   covers those after the fact).
 */
export async function depsAudit(this: NodePackHost, instanceId?: string): Promise<NodeDepsAudit> {
  const key = instanceId || 'default'
  // Audit must not read a venv while a node op is writing it. Node installs
  // do not take the env lock (they own opBatches/opAborts), so check both.
  if (this.isOpActive(key) || this.opBatches.has(key) || this.opAborts.has(key)) {
    return {
      ok: false,
      pipAvailable: true,
      checkedPacks: 0,
      packs: [],
      error: 'ENV_BUSY: a node operation is running — wait for it to finish'
    }
  }
  // One env lock shared with pipOps: an audit must never read a venv while a
  // package install is writing it.
  const release = acquireEnvLock(key, 'deps-audit')
  try {
    const packs = this.list(instanceId)
    const targets: Array<{
      pack: NodePackRecord
      reqs: PipRequirement[]
      unsupported?: string[]
    }> = []
    for (const pack of packs) {
      if (pack.status === 'disabled') continue
      try {
        const parsed = requirementsForPack(pack)
        if (parsed.reqs.length || parsed.unsupported.length) {
          targets.push({
            pack,
            reqs: parsed.reqs,
            unsupported: parsed.unsupported
          })
        }
      } catch {
        /* unreadable requirements — skip this pack */
      }
    }
    if (!targets.length) {
      return { ok: true, pipAvailable: true, checkedPacks: 0, packs: [] }
    }

    const vpy = resolveInstancePython(instanceId)
    if (!vpy) {
      return {
        ok: false,
        pipAvailable: false,
        checkedPacks: targets.length,
        packs: [],
        error: 'No Python interpreter resolved for this instance'
      }
    }
    // EnvMarker: audit and install must agree on the environment. A
    // repaired/replaced venv left a stale marker; silently auditing a
    // different interpreter was the source of "installed but still missing".
    try {
      const cfg = resolveInstanceConfig(instanceId)
      const markerFile = cfg ? join(dirname(cfg.path), '.comfypilot-env.json') : ''
      if (markerFile && existsSync(markerFile)) {
        const marker = JSON.parse(readFileSync(markerFile, 'utf-8')) as {
          venvPath?: string
          pythonVersion?: string
        }
        if (marker.venvPath) {
          const actualVenv = dirname(dirname(vpy))
          if (normalizeForCompare(marker.venvPath) !== normalizeForCompare(actualVenv)) {
            return {
              ok: false,
              pipAvailable: true,
              checkedPacks: targets.length,
              packs: [],
              error: `ENV_MISMATCH: marker says ${marker.venvPath}, audit resolved ${actualVenv}`
            }
          }
        }
        if (marker.pythonVersion && !/^3\.13\./.test(marker.pythonVersion)) {
          return {
            ok: false,
            pipAvailable: true,
            checkedPacks: targets.length,
            packs: [],
            error: `PYTHON_UNSUPPORTED: marker says ${marker.pythonVersion}`
          }
        }
      }
    } catch {
      /* a missing/corrupt marker is advisory; audit still runs */
    }

    const installed = await installedPackages(vpy)
    if (!installed) {
      return {
        ok: false,
        pipAvailable: false,
        checkedPacks: targets.length,
        packs: [],
        error: 'No package manager available (pip missing and uv unavailable)'
      }
    }
    const audit = auditPackRequirements(targets, installed)
    const check = await pipCheck(vpy)
    return {
      ok: true,
      pipAvailable: true,
      checkedPacks: targets.length,
      packs: audit.packs,
      unverifiable: audit.unverifiable.length ? audit.unverifiable : undefined,
      pipCheck: check
    }
  } finally {
    release()
  }
}

/**
 * (Re)install one pack's requirements into the instance environment
 * (0.1.12 WP5 action) — delegates to the pip-op service so the same busy
 * guard, streaming log and cancellation semantics apply.
 */
export async function installDeps(
  this: NodePackHost,
  idOrName: string,
  instanceId?: string,
  specs?: string[]
): Promise<PipOpResult> {
  // 0.2.0: the dependency-fix action must obey the same allow-pip gate as
  // a pack install. It previously bypassed it entirely.
  if (loadSettings().allowPipInstall === false) {
    throw codedError(
      'PIP_DISABLED',
      'pip installs are disabled in Settings — enable allow_pip_install first'
    )
  }
  const pack = this.list(instanceId).find((p) => p.id === idOrName || p.name === idOrName)
  if (!pack?.path) throw codedError('PACK_NOT_FOUND', `Node pack not found: ${idOrName}`)
  const { pipOpsService } = await import('../pipOps')
  // The audit already knows exactly which specs are missing/mismatched.
  // Installing only those is faster and avoids re-resolving the whole file.
  if (specs?.length) {
    return pipOpsService.installSpecs(instanceId || 'default', specs)
  }
  const reqFile = join(pack.path, 'requirements.txt')
  if (existsSync(reqFile)) {
    return pipOpsService.installRequirementsFor(instanceId, reqFile, pack.name)
  }
  const parsed = requirementsForPack(pack)
  const declared = parsed.reqs.map((r) => (r.specifier ? `${r.name}${r.specifier}` : r.name))
  if (!declared.length) {
    throw codedError(
      'NO_REQUIREMENTS',
      'This pack has no requirements.txt or pyproject dependencies'
    )
  }
  return pipOpsService.installSpecs(instanceId || 'default', declared)
}

export async function smokeTest(
  this: NodePackHost,
  idOrName: string,
  instanceId?: string
): Promise<NodePackIssue[]> {
  const pack = this.list(instanceId).find((p) => p.id === idOrName || p.name === idOrName)
  if (!pack?.path) return []
  const issues: NodePackIssue[] = []
  const python = resolveInstancePython(instanceId)
  // Import for real (exec_module) so syntax/import errors surface; path arrives via argv.
  const py = [
    'import importlib.util,sys,os,traceback',
    'p=sys.argv[1]',
    'f=os.path.join(p,"__init__.py")',
    'if not os.path.isfile(f):',
    '    sys.exit(3)',
    'try:',
    '    spec=importlib.util.spec_from_file_location("cp_pack",f)',
    '    if not spec or not spec.loader:',
    '        sys.exit(2)',
    '    m=importlib.util.module_from_spec(spec)',
    '    spec.loader.exec_module(m)',
    '    sys.exit(0)',
    'except Exception:',
    '    traceback.print_exc()',
    '    sys.exit(2)'
  ].join('\n')
  try {
    await execFileAsync(python, ['-c', py, pack.path], {
      timeout: 15000,
      cwd: pack.path,
      maxBuffer: 20 * 1024 * 1024
    })
  } catch (e) {
    const code = (e as { code?: number }).code
    const msg = e instanceof Error ? e.message : String(e)
    if (code === 3) {
      // Missing __init__.py is a low-severity packaging gap, not an import failure.
      issues.push({
        severity: 'warning',
        code: 'NO_INIT',
        message: 'No top-level __init__.py — skipped import smoke test.',
        suggestion: 'Add __init__.py if this pack should be importable as a package.',
        fixable: false
      })
    } else {
      issues.push({
        severity: 'error',
        code: 'IMPORT_FAIL',
        message: `Import smoke test failed: ${msg.slice(0, 220)}`,
        suggestion: 'Check requirements and Python version compatibility.',
        fixable: false
      })
    }
  }
  return issues
}

export const depsMethods = {
  pipDeps,
  depsAudit,
  installDeps,
  smokeTest
}
