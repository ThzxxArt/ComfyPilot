/**
 * One-shot data schema migration and legacy log consolidation.
 *
 * The schema version constant is re-exported here so `services/db` keeps its
 * historical public surface; the envelope helpers live in `schema.ts` because
 * `jsonc.ts` needs them without importing this module.
 */
import { app } from 'electron'
import { join } from 'path'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'fs'
import { isV2Envelope } from './schema'
import { parseJsonc, setDataMigrationGuard, writeJsonc } from './jsonc'
import { logsDir, userDataDir } from './paths'

export { DATA_SCHEMA_VERSION } from './schema'

interface DataMigrationState {
  checked: boolean
  ok: boolean
  snapshot?: string
  migratedFiles: number
  error?: string
}

const dataMigration: DataMigrationState = {
  checked: false,
  ok: true,
  migratedFiles: 0
}

/**
 * One-shot v1 → v2 migration with a full pre-upgrade snapshot. The snapshot is
 * written before the first file is touched; a failure restores every file and
 * leaves the app in a blocking `failed` state rather than silently reading v1.
 */
export function migrateData(): {
  ok: boolean
  snapshot?: string
  migratedFiles: number
  error?: string
} {
  if (dataMigration.checked) return dataMigration
  dataMigration.checked = true
  const dir = userDataDir()
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonc'))
  } catch (e) {
    dataMigration.ok = false
    dataMigration.error = e instanceof Error ? e.message : String(e)
    return dataMigration
  }
  const legacy: Array<{ file: string; name: string; value: unknown }> = []
  for (const file of files) {
    try {
      const parsed = parseJsonc<unknown>(readFileSync(join(dir, file), 'utf-8'))
      if (!isV2Envelope(parsed)) {
        legacy.push({ file, name: file.replace(/\.jsonc$/, ''), value: parsed })
      }
    } catch {
      // Parse failures are handled by readJsonc (.bad-<ts>), not migration.
    }
  }
  if (!legacy.length) {
    dataMigration.ok = true
    return dataMigration
  }
  const snapshot = join(dir, `pre-upgrade-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  try {
    mkdirSync(snapshot, { recursive: true })
    for (const file of files) {
      copyFileSync(join(dir, file), join(snapshot, file))
    }
    dataMigration.snapshot = snapshot
  } catch (e) {
    dataMigration.ok = false
    dataMigration.error = `pre-upgrade snapshot failed: ${e instanceof Error ? e.message : String(e)}`
    return dataMigration
  }
  try {
    for (const entry of legacy) {
      writeJsonc(entry.name, entry.value)
      dataMigration.migratedFiles += 1
    }
    dataMigration.ok = true
  } catch (e) {
    // Restore the exact pre-migration bytes. The snapshot remains for manual
    // recovery even if the restore itself partially fails.
    for (const file of files) {
      try {
        copyFileSync(join(snapshot, file), join(dir, file))
      } catch {
        /* keep the snapshot as the source of truth */
      }
    }
    dataMigration.ok = false
    dataMigration.error = e instanceof Error ? e.message : String(e)
  }
  return dataMigration
}

export function getDataMigrationState(): {
  ok: boolean
  snapshot?: string
  migratedFiles: number
  error?: string
} {
  migrateData()
  return { ...dataMigration }
}

/** 0.2.0: explicit retry from the blocking migration screen. */
export function retryDataMigration(): {
  ok: boolean
  snapshot?: string
  migratedFiles: number
  error?: string
} {
  dataMigration.checked = false
  dataMigration.ok = true
  dataMigration.error = undefined
  migrateData()
  return { ...dataMigration }
}

export function ensureDataMigrated(): void {
  migrateData()
  if (!dataMigration.ok) {
    throw new Error(
      `DATA_MIGRATION_FAILED: ${dataMigration.error || 'unknown error'} (snapshot: ${dataMigration.snapshot || 'none'})`
    )
  }
}

let legacyLogsMigrated = false

/**
 * One-shot consolidation of the legacy boot log (0.1.16).
 *
 * `bootstrap.cjs` and the early `crashLog` helper hardcoded
 * `%APPDATA%/ComfyPilot/logs` while the real Electron userData is
 * `%APPDATA%/comfy-pilot` (app `name` ≠ `productName`). The "open logs dir"
 * button therefore pointed at an empty folder and README documented the wrong
 * path. Everything now lives under `logsDir()`; this appends the old boot log
 * (if any) and marks it migrated. Best-effort — never blocks startup.
 */
export function migrateLegacyLogs(): void {
  if (legacyLogsMigrated) return
  legacyLogsMigrated = true
  try {
    const legacyDir = join(app.getPath('appData'), 'ComfyPilot', 'logs')
    const target = logsDir()
    const norm = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (norm(legacyDir) === norm(target)) return
    const legacyBoot = join(legacyDir, 'boot.log')
    if (!existsSync(legacyBoot)) return
    const targetBoot = join(target, 'boot.log')
    const legacyText = readFileSync(legacyBoot, 'utf-8')
    if (existsSync(targetBoot)) appendFileSync(targetBoot, legacyText)
    else writeFileSync(targetBoot, legacyText, 'utf-8')
    try {
      renameSync(legacyBoot, legacyBoot + '.migrated')
    } catch {
      /* leave it in place if locked */
    }
  } catch {
    /* best effort */
  }
}

// `readJsonc` runs this before serving any file. Installing the guard here
// keeps the dependency one-way (migration → jsonc, never jsonc → migration).
setDataMigrationGuard(ensureDataMigrated)
