import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from 'fs'
import { join } from 'path'
import { execFile, execSync } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import net from 'net'
import type { DoctorCheck, DoctorReport, DoctorSeverity } from '@shared/types'
import { loadInstanceConfigs, loadSettings } from './db'
import { REGISTRY_API } from '@shared/constants'
import { parseExtraModelPaths } from './model'

const execFileAsync = promisify(execFile)

async function safeExec(cmd: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      timeout: 10000,
      windowsHide: true
    })
    return stdout.trim()
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => server.close(() => resolve(false)))
    server.listen(port, '0.0.0.0')
  })
}

export class DoctorService {
  async run(instanceId: string): Promise<DoctorReport> {
    const started = Date.now()
    const configs = loadInstanceConfigs()
    const config = configs.find((c) => c.id === instanceId) || configs[0]
    const settings = loadSettings()
    const checks: DoctorCheck[] = []

    // 1. install path
    const installPath = config?.path || settings.defaultInstancePath
    const hasMain = installPath ? existsSync(join(installPath, 'main.py')) : false
    checks.push({
      id: 'install-path',
      group: 'Environment',
      title: 'ComfyUI installation path',
      severity: installPath && hasMain ? 'pass' : installPath ? 'fail' : 'warn',
      detail: installPath
        ? hasMain
          ? `Found main.py at ${installPath}`
          : `Path exists but main.py missing: ${installPath}`
        : 'No instance path configured',
      suggestion: hasMain ? undefined : 'Set the ComfyUI root folder in Instance settings.',
      fixable: false
    })

    // 2. Python
    const python = config?.venvPath
      ? existsSync(join(config.venvPath, 'Scripts', 'python.exe'))
        ? join(config.venvPath, 'Scripts', 'python.exe')
        : existsSync(join(config.venvPath, 'bin', 'python'))
          ? join(config.venvPath, 'bin', 'python')
          : config?.pythonPath || 'python'
      : config?.pythonPath || 'python'
    const pyOut = await safeExec(python, ['--version'])
    const pyOk = /python\s+3\.(1[0-9])/i.test(pyOut)
    checks.push({
      id: 'python',
      group: 'Environment',
      title: 'Python interpreter',
      severity: pyOk ? 'pass' : 'fail',
      detail: pyOut || 'Python not found',
      suggestion: pyOk ? undefined : 'Install Python 3.12/3.13 and point the instance to it.',
      fixable: false
    })

    // 3. Torch / CUDA
    const torchOut = await safeExec(python, [
      '-c',
      'import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())'
    ])
    const torchOk = /True|^\d+\./.test(torchOut) && !/Error|Traceback|No module/i.test(torchOut)
    checks.push({
      id: 'torch',
      group: 'Runtime',
      title: 'PyTorch & CUDA',
      severity: torchOk ? 'pass' : 'warn',
      detail: torchOut || 'torch not importable',
      suggestion: torchOk
        ? undefined
        : 'Install a torch build matching your GPU driver (cu130+ recommended for NVIDIA 20+).',
      fixable: false
    })

    // 4. models dir
    const modelRoot = installPath ? join(installPath, 'models') : ''
    const hasModels = modelRoot && existsSync(modelRoot)
    checks.push({
      id: 'models-dir',
      group: 'Storage',
      title: 'Models directory',
      severity: hasModels ? 'pass' : 'warn',
      detail: hasModels ? `Found ${modelRoot}` : 'models directory not found',
      suggestion: hasModels ? undefined : 'Create models/ under the ComfyUI root or configure extra_model_paths.yaml.',
      fixable: !hasModels && Boolean(installPath),
      fixId: 'create-models-dir'
    })

    // 5. custom_nodes
    const customNodes = installPath ? join(installPath, 'custom_nodes') : ''
    const hasCN = customNodes && existsSync(customNodes)
    checks.push({
      id: 'custom-nodes',
      group: 'Extensions',
      title: 'custom_nodes directory',
      severity: hasCN ? 'pass' : 'warn',
      detail: hasCN ? `Found ${customNodes}` : 'custom_nodes missing',
      fixable: !hasCN && Boolean(installPath),
      fixId: 'create-custom-nodes'
    })

    // 6. extra_model_paths.yaml validity
    const emp = installPath ? join(installPath, 'extra_model_paths.yaml') : ''
    const hasEmp = emp && existsSync(emp)
    let empPaths: string[] = []
    if (hasEmp) {
      empPaths = parseExtraModelPaths(emp, true)
      const broken = empPaths.filter((p) => !existsSync(p))
      checks.push({
        id: 'extra-paths',
        group: 'Storage',
        title: 'extra_model_paths.yaml',
        severity: broken.length ? 'warn' : 'pass',
        detail: broken.length
          ? `Broken paths (${broken.length}): ${broken.slice(0, 3).join(', ')}${broken.length > 3 ? '…' : ''}`
          : `OK, ${empPaths.length} extra roots`,
        suggestion: broken.length ? 'Remove or fix missing paths in extra_model_paths.yaml.' : undefined,
        fixable: false
      })
    } else {
      checks.push({
        id: 'extra-paths',
        group: 'Storage',
        title: 'extra_model_paths.yaml',
        severity: 'info',
        detail: 'Not present (optional)',
        suggestion: 'Add shared model paths if you use A1111/Forge folders.',
        fixable: Boolean(installPath),
        fixId: 'write-extra-model-paths'
      })
    }

    // 7. port
    const port = config?.port || 8188
    const portBusy = await isPortInUse(port)
    checks.push({
      id: 'port',
      group: 'Network',
      title: 'Listen address / port',
      severity: portBusy && config ? 'warn' : 'pass',
      detail: `${config?.listen || '127.0.0.1'}:${port}${portBusy ? ' (currently in use)' : ''}`,
      suggestion: portBusy ? 'Port is in use — stop the conflicting process or choose another port.' : undefined,
      fixable: false
    })

    // 8. custom_nodes import smoke (dir count + entry sanity)
    if (hasCN && customNodes) {
      try {
        const { readdirSync } = await import('fs')
        const packs = readdirSync(customNodes).filter((n) => !n.startsWith('.'))
        const broken: string[] = []
        for (const name of packs.slice(0, 30)) {
          const dir = join(customNodes, name)
          const hasEntry =
            existsSync(join(dir, '__init__.py')) ||
            existsSync(join(dir, 'pyproject.toml')) ||
            existsSync(join(dir, 'requirements.txt'))
          if (!hasEntry) broken.push(name)
        }
        checks.push({
          id: 'cn-count',
          group: 'Extensions',
          title: 'Custom node packs',
          severity: broken.length ? 'warn' : 'pass',
          detail: broken.length
            ? `${packs.length} packs, ${broken.length} missing entry: ${broken.slice(0, 3).join(', ')}`
            : `${packs.length} packs found`,
          suggestion: broken.length ? 'Remove or repair packs without __init__.py/pyproject.toml.' : undefined,
          fixable: false
        })
      } catch {
        /* ignore */
      }
    }

    // 8b. disk space for models / output
    if (installPath) {
      try {
        const { statfsSync } = await import('fs')
        const modelsDir = join(installPath, 'models')
        const outputDir = join(installPath, 'output')
        for (const [label, dir] of [
          ['models', modelsDir],
          ['output', outputDir]
        ] as const) {
          if (!existsSync(dir)) continue
          const st = statfsSync(dir)
          const free = Number(st.bsize) * Number(st.bavail)
          const total = Number(st.bsize) * Number(st.blocks)
          const freeGb = (free / 1024 ** 3).toFixed(1)
          const low = free < 5 * 1024 ** 3
          checks.push({
            id: `disk-${label}`,
            group: 'Storage',
            title: `Disk free (${label})`,
            severity: low ? 'warn' : 'pass',
            detail: `${freeGb} GB free of ${(total / 1024 ** 3).toFixed(1)} GB`,
            suggestion: low ? 'Low disk space — free up space before large model downloads.' : undefined,
            fixable: false
          })
        }
      } catch {
        /* statfs may be unavailable */
      }
    }

    // 9. disk space
    if (settings.downloadDir && existsSync(settings.downloadDir)) {
      try {
        statSync(settings.downloadDir)
        checks.push({
          id: 'download-dir',
          group: 'Storage',
          title: 'Download directory',
          severity: 'pass',
          detail: settings.downloadDir,
          fixable: false
        })
      } catch {
        /* ignore */
      }
    }

    // 10. Manager / Registry connectivity
    let registryOk = false
    try {
      const res = await fetch(`${REGISTRY_API}/nodes?limit=1`, {
        signal: AbortSignal.timeout(5000)
      })
      registryOk = res.ok
    } catch {
      registryOk = false
    }
    checks.push({
      id: 'registry',
      group: 'Network',
      title: 'Comfy Registry connectivity',
      severity: registryOk ? 'pass' : settings.networkMode === 'offline' ? 'info' : 'warn',
      detail: registryOk
        ? `Reachable ${REGISTRY_API}`
        : settings.networkMode === 'offline'
          ? 'Offline mode — skip registry checks'
          : 'Cannot reach Comfy Registry',
      suggestion: registryOk || settings.networkMode === 'offline'
        ? undefined
        : 'Check proxy/firewall or set GitHub/HF endpoint in Settings.',
      fixable: false
    })

    // 11. Manager enabled flag
    const managerEnabled = Boolean(config?.extraArgs?.some((a) => a.includes('enable-manager')))
    checks.push({
      id: 'manager',
      group: 'Extensions',
      title: 'ComfyUI-Manager flag',
      severity: managerEnabled ? 'pass' : 'info',
      detail: managerEnabled ? '--enable-manager present' : 'Manager not forced on launch',
      suggestion: managerEnabled ? undefined : 'Enable Manager launch template if you use it.',
      fixable: false
    })

    // 12. requirements.txt exists
    if (installPath) {
      const req = join(installPath, 'requirements.txt')
      checks.push({
        id: 'requirements',
        group: 'Environment',
        title: 'requirements.txt',
        severity: existsSync(req) ? 'pass' : 'warn',
        detail: existsSync(req) ? req : 'requirements.txt missing',
        fixable: false
      })
    }

    const summary = {
      pass: checks.filter((c) => c.severity === 'pass').length,
      warn: checks.filter((c) => c.severity === 'warn').length,
      fail: checks.filter((c) => c.severity === 'fail').length,
      info: checks.filter((c) => c.severity === 'info').length
    }

    return {
      id: randomUUID(),
      instanceId: instanceId || 'default',
      createdAt: Date.now(),
      durationMs: Date.now() - started,
      checks,
      summary
    }
  }

  async fix(instanceId: string, fixId: string): Promise<{ ok: boolean; message: string }> {
    const configs = loadInstanceConfigs()
    const config = configs.find((c) => c.id === instanceId) || configs[0]
    const settings = loadSettings()
    const installPath = config?.path || settings.defaultInstancePath
    if (!installPath) return { ok: false, message: 'No instance path' }

    switch (fixId) {
      case 'create-models-dir': {
        const dir = join(installPath, 'models')
        mkdirSync(dir, { recursive: true })
        for (const sub of ['checkpoints', 'loras', 'vae', 'clip', 'controlnet', 'upscale_models', 'embeddings', 'unet', 'diffusion_models']) {
          mkdirSync(join(dir, sub), { recursive: true })
        }
        return { ok: true, message: `Created models tree at ${dir}` }
      }
      case 'create-custom-nodes': {
        const dir = join(installPath, 'custom_nodes')
        mkdirSync(dir, { recursive: true })
        return { ok: true, message: `Created ${dir}` }
      }
      case 'unpin-torch': {
        // Real fix: rewrite requirements.txt to relax exact torch pins
        try {
          const { readdirSync } = await import('fs')
          const customNodes = join(installPath, 'custom_nodes')
          if (!existsSync(customNodes)) return { ok: false, message: 'custom_nodes missing' }
          let fixed = 0
          for (const name of readdirSync(customNodes)) {
            const req = join(customNodes, name, 'requirements.txt')
            if (!existsSync(req)) continue
            const text = readFileSync(req, 'utf-8')
            const next = text.replace(/torch\s*==\s*[^\s;]+/gi, 'torch>=2.0')
            if (next !== text) {
              writeFileSync(req, next)
              fixed += 1
            }
          }
          return {
            ok: true,
            message: fixed ? `Relaxed torch pins in ${fixed} requirements.txt` : 'No exact torch pins found'
          }
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) }
        }
      }
      case 'write-extra-model-paths': {
        const file = join(installPath, 'extra_model_paths.yaml')
        if (!existsSync(file)) {
          writeFileSync(
            file,
            `# ComfyPilot generated\ncomfyui:\n  base_path: ${installPath.replace(/\\/g, '/')}\n  checkpoints: models/checkpoints\n  loras: models/loras\n  vae: models/vae\n`
          )
          return { ok: true, message: `Wrote ${file}` }
        }
        return { ok: true, message: 'extra_model_paths.yaml already exists' }
      }
      default:
        return { ok: false, message: `Unknown fix: ${fixId}` }
    }
  }
}

export const doctorService = new DoctorService()

void execSync
void appendFileSync
void rmSync
void readFileSync
export type { DoctorSeverity }
