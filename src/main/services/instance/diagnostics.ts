import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DiagnosticPackage } from '@shared/types'
import { resolveEffectiveInstance } from '@shared/instanceLayout'
import { loadInstanceConfigs, userDataDir } from '../db'
import type { InstanceServiceContext } from './types'

export async function exportDiagnostics(
  ctx: InstanceServiceContext,
  id: string
): Promise<DiagnosticPackage> {
  const configs = loadInstanceConfigs()
  const config = configs.find((c) => c.id === id)
  const createdAt = Date.now()
  const dir = join(userDataDir(), 'diagnostics', `${id}-${createdAt}`)
  mkdirSync(dir, { recursive: true })
  const contents: string[] = []

  // config
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(config, null, 2))
  contents.push('instance.json')

  // logs
  const rt = ctx.runtimes.get(id)
  const logs = rt?.logs || ctx.readLogFile(id)
  writeFileSync(
    join(dir, 'console.log'),
    logs.map((l) => `[${new Date(l.ts).toISOString()}] ${l.level} ${l.message}`).join('\n')
  )
  contents.push('console.log')

  // env probe (Python / venv / torch / CUDA / migration state)
  try {
    const probe = await ctx.probeEnv(id)
    writeFileSync(join(dir, 'env.json'), JSON.stringify(probe, null, 2))
    contents.push('env.json')
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify(
        {
          pythonVersion: probe.pythonVersion,
          torchVersion: probe.torchVersion,
          cudaVersion: probe.cudaVersion,
          rocmVersion: probe.rocmVersion,
          pipAvailable: probe.pip?.present,
          venvPath: config?.venvPath,
          migrationState: config?.migrationState,
          migrationError: config?.migrationError,
          configuredPythonVersion: config?.pythonVersion
        },
        null,
        2
      )
    )
    contents.push('runtime.json')
    if (config?.venvPath) {
      const pyvenv = join(config.venvPath, 'pyvenv.cfg')
      if (existsSync(pyvenv)) {
        writeFileSync(join(dir, 'pyvenv.cfg'), readFileSync(pyvenv, 'utf-8'))
        contents.push('pyvenv.cfg')
      }
    }
  } catch {
    /* ignore */
  }

  // extra_model_paths + effective asset directories
  if (config?.path) {
    const effective = resolveEffectiveInstance(config)
    writeFileSync(join(dir, 'paths.json'), JSON.stringify(effective, null, 2))
    contents.push('paths.json')
    const emp = join(config.path, 'extra_model_paths.yaml')
    if (existsSync(emp)) {
      writeFileSync(join(dir, 'extra_model_paths.yaml'), readFileSync(emp, 'utf-8'))
      contents.push('extra_model_paths.yaml')
    }
    const custom = effective.dirs.customNodes
    if (existsSync(custom)) {
      writeFileSync(join(dir, 'custom_nodes.txt'), readdirSync(custom).join('\n'))
      contents.push('custom_nodes.txt')
    }
  }

  // 0.2.5 WP2: health evidence, process and port facts.
  if (config) {
    try {
      const { instanceHealthService } = await import('./health')
      let health = instanceHealthService.get(id)
      if (!health) {
        try {
          health = await instanceHealthService.check(id)
        } catch {
          health = undefined
        }
      }
      if (health) {
        writeFileSync(join(dir, 'health.json'), JSON.stringify(health, null, 2))
        contents.push('health.json')
      }
      const effective = resolveEffectiveInstance(config)
      writeFileSync(
        join(dir, 'ports.json'),
        JSON.stringify(
          {
            configuredPort: config.port,
            effectivePort: effective.port,
            configuredListen: config.listen,
            effectiveListen: effective.listen,
            probeHost: effective.probeHost,
            url: effective.url
          },
          null,
          2
        )
      )
      contents.push('ports.json')
      writeFileSync(
        join(dir, 'process.json'),
        JSON.stringify(
          {
            instanceId: id,
            pid: rt?.pid,
            status: rt?.status,
            managed: rt?.managed,
            startedAt: rt?.startedAt,
            lastLogAt: rt?.lastLogAt,
            lastExit: rt?.lastExit
          },
          null,
          2
        )
      )
      contents.push('process.json')
    } catch {
      /* health evidence is best-effort */
    }
  }

  // Online facts (0.1.10): /system_stats + /features give offline diagnosis
  // the exact version/packages/argv/feature-flag surface of the instance.
  if (config?.port) {
    const base = ctx.baseUrlOf(config)
    for (const [file, path] of [
      ['system-stats.json', '/system_stats'],
      ['features.json', '/features']
    ] as const) {
      try {
        const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2500) })
        if (res.ok) {
          writeFileSync(join(dir, file), JSON.stringify(await res.json(), null, 2))
          contents.push(file)
        }
      } catch {
        /* offline — the diagnostics package simply omits this file */
      }
    }
  }

  // Attribution facts (0.1.10): the prompt↔workflow sidecar plus a batch
  // linkage summary, so offline diagnosis can explain output provenance.
  try {
    const linksFile = join(userDataDir(), 'prompt_links.jsonc')
    let linksCount = 0
    if (existsSync(linksFile)) {
      writeFileSync(join(dir, 'prompt-links.json'), readFileSync(linksFile, 'utf-8'))
      contents.push('prompt-links.json')
      try {
        linksCount = Object.keys(JSON.parse(readFileSync(linksFile, 'utf-8')) as object).length
      } catch {
        linksCount = 0
      }
    }
    const { listBatchJobs } = await import('../db')
    const jobs = listBatchJobs()
    let batchOutputLinks = 0
    for (const job of jobs) {
      for (const item of job.items) batchOutputLinks += item.outputPaths?.length || 0
    }
    writeFileSync(
      join(dir, 'attribution.json'),
      JSON.stringify(
        {
          promptLinks: linksCount,
          batchJobs: jobs.length,
          batchOutputLinks
        },
        null,
        2
      )
    )
    contents.push('attribution.json')
  } catch {
    /* attribution is best-effort */
  }

  let size = 0
  for (const f of contents) {
    try {
      size += statSync(join(dir, f)).size
    } catch {
      /* ignore */
    }
  }

  return { path: dir, createdAt, size, contents }
}

export async function copyDiagnostics(ctx: InstanceServiceContext, id: string): Promise<string> {
  const pkg = await ctx.exportDiagnostics(id)
  return pkg.path
}
