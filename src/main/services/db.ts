import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type {
  AppSettings,
  BatchJob,
  BackupManifest,
  ComfyInstanceConfig,
  DownloadTask,
  ModelRecord,
  NodeSnapshot,
  OutputAsset,
  RemoteInstanceConfig,
  WorkflowRecord
} from '@shared/types'

let db: Database.Database | null = null

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function userDataDir(): string {
  return ensureDir(join(app.getPath('userData'), 'data'))
}

export function cacheDir(): string {
  return ensureDir(join(app.getPath('userData'), 'cache'))
}

export function logsDir(): string {
  return ensureDir(join(app.getPath('userData'), 'logs'))
}

export function backupDir(): string {
  return ensureDir(join(userDataDir(), 'backups'))
}

export function snapshotDir(): string {
  return ensureDir(join(userDataDir(), 'node-snapshots'))
}

export function getDb(): Database.Database {
  if (db) return db
  const file = join(userDataDir(), 'comfy-pilot.sqlite')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  migrate(db)
  return db
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      python_path TEXT DEFAULT '',
      venv_path TEXT DEFAULT '',
      port INTEGER DEFAULT 8188,
      listen TEXT DEFAULT '127.0.0.1',
      extra_args TEXT DEFAULT '[]',
      arg_template_id TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      notes TEXT DEFAULT '',
      auto_start INTEGER DEFAULT 0,
      frontend_version TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      category TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      size INTEGER DEFAULT 0,
      hash_sha256 TEXT,
      modified_at INTEGER DEFAULT 0,
      architecture TEXT,
      source TEXT DEFAULT 'local',
      thumbnail TEXT,
      tags TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      base_model TEXT,
      trained_words TEXT DEFAULT '[]',
      duplicate_of TEXT,
      path_root TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_models_hash ON models(hash_sha256);
    CREATE INDEX IF NOT EXISTS idx_models_category ON models(category);

    CREATE TABLE IF NOT EXISTS node_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      description TEXT DEFAULT '',
      author TEXT DEFAULT '',
      version TEXT DEFAULT '0.0.0',
      latest_version TEXT,
      status TEXT DEFAULT 'installed',
      path TEXT,
      repository TEXT,
      registry_id TEXT,
      node_count INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      python_compatible TEXT,
      install_source TEXT DEFAULT 'local',
      last_checked_at INTEGER,
      issues TEXT DEFAULT '[]',
      locked INTEGER DEFAULT 0,
      node_list TEXT DEFAULT '[]',
      license TEXT,
      icon TEXT
    );

    CREATE TABLE IF NOT EXISTS node_snapshots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      packs TEXT NOT NULL,
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      format TEXT DEFAULT 'json',
      node_count INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      description TEXT,
      updated_at INTEGER DEFAULT 0,
      thumbnail TEXT,
      missing_nodes TEXT DEFAULT '[]',
      version TEXT DEFAULT '1.0',
      seed INTEGER,
      model_used TEXT,
      params TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      dest_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      total_bytes INTEGER DEFAULT 0,
      received_bytes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      source TEXT DEFAULT 'direct'
    );

    CREATE TABLE IF NOT EXISTS doctor_reports (
      id TEXT PRIMARY KEY,
      instance_id TEXT,
      created_at INTEGER,
      duration_ms INTEGER,
      checks TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS batch_jobs (
      id TEXT PRIMARY KEY,
      name TEXT,
      workflow_path TEXT,
      instance_id TEXT,
      count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'queued',
      completed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      created_at INTEGER,
      finished_at INTEGER,
      prompt_ids TEXT DEFAULT '[]',
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at INTEGER,
      path TEXT,
      size INTEGER DEFAULT 0,
      includes TEXT,
      notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS output_assets (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      file_name TEXT,
      type TEXT DEFAULT 'other',
      size INTEGER DEFAULT 0,
      created_at INTEGER,
      width INTEGER,
      height INTEGER,
      workflow_id TEXT,
      prompt_id TEXT,
      seed INTEGER,
      params TEXT DEFAULT '{}',
      thumbnail TEXT
    );

    CREATE TABLE IF NOT EXISTS remote_instances (
      id TEXT PRIMARY KEY,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      label TEXT,
      enabled INTEGER DEFAULT 1
    );
  `)
}

// ---------- Settings ----------
export function loadSettings(): AppSettings {
  const d = getDb()
  const rows = d.prepare('SELECT key, value FROM settings').all() as Array<{
    key: string
    value: string
  }>
  const map = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) as Partial<AppSettings>
  // Deep-merge nested proxy so partial stored objects don't wipe defaults
  return {
    ...DEFAULT_SETTINGS,
    ...map,
    proxy: { ...DEFAULT_SETTINGS.proxy, ...(map.proxy || {}) }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const d = getDb()
  const current = loadSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    proxy: { ...current.proxy, ...(patch.proxy || {}) }
  }
  const upsert = d.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  const tx = d.transaction((entries: Array<[string, unknown]>) => {
    for (const [k, v] of entries) upsert.run(k, JSON.stringify(v))
  })
  // Persist each top-level key including nested proxy as one blob
  tx(Object.entries(next).map(([k, v]) => [k, v] as [string, unknown]))
  return next
}

// ---------- Instances ----------
export function loadInstanceConfigs(): ComfyInstanceConfig[] {
  const d = getDb()
  const rows = d.prepare('SELECT * FROM instances').all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    pythonPath: String(r.python_path || ''),
    venvPath: String(r.venv_path || ''),
    port: Number(r.port || 8188),
    listen: String(r.listen || '127.0.0.1'),
    extraArgs: JSON.parse(String(r.extra_args || '[]')),
    argTemplateId: String(r.arg_template_id || ''),
    enabled: Boolean(r.enabled),
    notes: String(r.notes || ''),
    autoStart: Boolean(r.auto_start),
    frontendVersion: String(r.frontend_version || '')
  }))
}

export function upsertInstanceConfig(config: ComfyInstanceConfig): void {
  const d = getDb()
  d.prepare(
    `INSERT INTO instances (id, name, path, python_path, venv_path, port, listen, extra_args, arg_template_id, enabled, notes, auto_start, frontend_version)
     VALUES (@id, @name, @path, @pythonPath, @venvPath, @port, @listen, @extraArgs, @argTemplateId, @enabled, @notes, @autoStart, @frontendVersion)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, path=excluded.path, python_path=excluded.python_path, venv_path=excluded.venv_path,
       port=excluded.port, listen=excluded.listen, extra_args=excluded.extra_args, arg_template_id=excluded.arg_template_id,
       enabled=excluded.enabled, notes=excluded.notes, auto_start=excluded.auto_start, frontend_version=excluded.frontend_version`
  ).run({
    id: config.id,
    name: config.name,
    path: config.path,
    pythonPath: config.pythonPath || '',
    venvPath: config.venvPath || '',
    port: config.port || 8188,
    listen: config.listen || '127.0.0.1',
    extraArgs: JSON.stringify(config.extraArgs || []),
    argTemplateId: config.argTemplateId || '',
    enabled: config.enabled ? 1 : 0,
    notes: config.notes || '',
    autoStart: config.autoStart ? 1 : 0,
    frontendVersion: config.frontendVersion || ''
  })
}

export function deleteInstanceConfig(id: string): boolean {
  const res = getDb().prepare('DELETE FROM instances WHERE id = ?').run(id)
  return res.changes > 0
}

// ---------- Models ----------
function rowToModel(r: Record<string, unknown>): ModelRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    fileName: String(r.file_name),
    category: String(r.category) as ModelRecord['category'],
    path: String(r.path),
    size: Number(r.size || 0),
    hashSha256: r.hash_sha256 ? String(r.hash_sha256) : undefined,
    modifiedAt: Number(r.modified_at || 0),
    architecture: r.architecture ? String(r.architecture) : undefined,
    source: String(r.source || 'local') as ModelRecord['source'],
    thumbnail: r.thumbnail ? String(r.thumbnail) : undefined,
    tags: JSON.parse(String(r.tags || '[]')),
    metadata: JSON.parse(String(r.metadata || '{}')),
    baseModel: r.base_model ? String(r.base_model) : undefined,
    trainedWords: JSON.parse(String(r.trained_words || '[]')),
    duplicateOf: r.duplicate_of ? String(r.duplicate_of) : undefined,
    pathRoot: String(r.path_root || '')
  }
}

export function upsertModel(m: ModelRecord): void {
  getDb()
    .prepare(
      `INSERT INTO models (id, name, file_name, category, path, size, hash_sha256, modified_at, architecture, source, thumbnail, tags, metadata, base_model, trained_words, duplicate_of, path_root)
       VALUES (@id, @name, @fileName, @category, @path, @size, @hashSha256, @modifiedAt, @architecture, @source, @thumbnail, @tags, @metadata, @baseModel, @trainedWords, @duplicateOf, @pathRoot)
       ON CONFLICT(path) DO UPDATE SET
         name=excluded.name, file_name=excluded.file_name, category=excluded.category, size=excluded.size,
         hash_sha256=COALESCE(excluded.hash_sha256, models.hash_sha256), modified_at=excluded.modified_at,
         architecture=excluded.architecture, source=excluded.source, thumbnail=excluded.thumbnail,
         tags=excluded.tags, metadata=excluded.metadata, base_model=excluded.base_model,
         trained_words=excluded.trained_words, duplicate_of=excluded.duplicate_of, path_root=excluded.path_root`
    )
    .run({
      id: m.id,
      name: m.name,
      fileName: m.fileName,
      category: m.category,
      path: m.path,
      size: m.size,
      hashSha256: m.hashSha256 || null,
      modifiedAt: m.modifiedAt,
      architecture: m.architecture || null,
      source: m.source,
      thumbnail: m.thumbnail || null,
      tags: JSON.stringify(m.tags || []),
      metadata: JSON.stringify(m.metadata || {}),
      baseModel: m.baseModel || null,
      trainedWords: JSON.stringify(m.trainedWords || []),
      duplicateOf: m.duplicateOf || null,
      pathRoot: m.pathRoot || ''
    })
}

export function listModels(): ModelRecord[] {
  const rows = getDb().prepare('SELECT * FROM models ORDER BY modified_at DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map(rowToModel)
}

export function deleteModel(id: string): boolean {
  return getDb().prepare('DELETE FROM models WHERE id = ?').run(id).changes > 0
}

export function findModelByPath(path: string): ModelRecord | null {
  const r = getDb().prepare('SELECT * FROM models WHERE path = ?').get(path) as
    | Record<string, unknown>
    | undefined
  return r ? rowToModel(r) : null
}

export function updateModel(id: string, patch: Partial<ModelRecord>): void {
  const fields: string[] = []
  const values: Record<string, unknown> = { id }
  if (patch.name !== undefined) {
    fields.push('name = @name')
    values.name = patch.name
  }
  if (patch.tags !== undefined) {
    fields.push('tags = @tags')
    values.tags = JSON.stringify(patch.tags)
  }
  if (patch.hashSha256 !== undefined) {
    fields.push('hash_sha256 = @hashSha256')
    values.hashSha256 = patch.hashSha256
  }
  if (patch.duplicateOf !== undefined) {
    fields.push('duplicate_of = @duplicateOf')
    values.duplicateOf = patch.duplicateOf
  }
  if (!fields.length) return
  getDb().prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = @id`).run(values)
}

// ---------- Node packs ----------
function rowToNodePack(r: Record<string, unknown>): import('@shared/types').NodePackRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    displayName: String(r.display_name || r.name),
    description: String(r.description || ''),
    author: String(r.author || ''),
    version: String(r.version || '0.0.0'),
    latestVersion: r.latest_version ? String(r.latest_version) : undefined,
    status: String(r.status || 'installed') as import('@shared/types').NodePackStatus,
    path: r.path ? String(r.path) : undefined,
    repository: r.repository ? String(r.repository) : undefined,
    registryId: r.registry_id ? String(r.registry_id) : undefined,
    nodeCount: Number(r.node_count || 0),
    tags: JSON.parse(String(r.tags || '[]')),
    pythonCompatible: r.python_compatible ? String(r.python_compatible) : undefined,
    installSource: String(r.install_source || 'local') as import('@shared/types').NodePackRecord['installSource'],
    lastCheckedAt: r.last_checked_at ? Number(r.last_checked_at) : undefined,
    issues: JSON.parse(String(r.issues || '[]')),
    locked: Boolean(r.locked),
    nodeList: JSON.parse(String(r.node_list || '[]')),
    license: r.license ? String(r.license) : undefined,
    icon: r.icon ? String(r.icon) : undefined
  }
}

export function upsertNodePack(p: import('@shared/types').NodePackRecord): void {
  getDb()
    .prepare(
      `INSERT INTO node_packs (id, name, display_name, description, author, version, latest_version, status, path, repository, registry_id, node_count, tags, python_compatible, install_source, last_checked_at, issues, locked, node_list, license, icon)
       VALUES (@id, @name, @displayName, @description, @author, @version, @latestVersion, @status, @path, @repository, @registryId, @nodeCount, @tags, @pythonCompatible, @installSource, @lastCheckedAt, @issues, @locked, @nodeList, @license, @icon)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, display_name=excluded.display_name, description=excluded.description,
         author=excluded.author, version=excluded.version, latest_version=excluded.latest_version,
         status=excluded.status, path=excluded.path, repository=excluded.repository, registry_id=excluded.registry_id,
         node_count=excluded.node_count, tags=excluded.tags, python_compatible=excluded.python_compatible,
         install_source=excluded.install_source, last_checked_at=excluded.last_checked_at, issues=excluded.issues,
         locked=excluded.locked, node_list=excluded.node_list, license=excluded.license, icon=excluded.icon`
    )
    .run({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      author: p.author,
      version: p.version,
      latestVersion: p.latestVersion || null,
      status: p.status,
      path: p.path || null,
      repository: p.repository || null,
      registryId: p.registryId || null,
      nodeCount: p.nodeCount,
      tags: JSON.stringify(p.tags || []),
      pythonCompatible: p.pythonCompatible || null,
      installSource: p.installSource,
      lastCheckedAt: p.lastCheckedAt || null,
      issues: JSON.stringify(p.issues || []),
      locked: p.locked ? 1 : 0,
      nodeList: JSON.stringify(p.nodeList || []),
      license: p.license || null,
      icon: p.icon || null
    })
}

export function listNodePacks(): import('@shared/types').NodePackRecord[] {
  const rows = getDb().prepare('SELECT * FROM node_packs').all() as Array<Record<string, unknown>>
  return rows.map(rowToNodePack)
}

export function deleteNodePack(id: string): boolean {
  return getDb().prepare('DELETE FROM node_packs WHERE id = ?').run(id).changes > 0
}

// ---------- Snapshots ----------
export function listSnapshots(): NodeSnapshot[] {
  const rows = getDb()
    .prepare('SELECT * FROM node_snapshots ORDER BY created_at DESC')
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    packs: JSON.parse(String(r.packs || '[]')),
    notes: String(r.notes || '')
  }))
}

export function insertSnapshot(s: NodeSnapshot): void {
  getDb()
    .prepare(
      'INSERT INTO node_snapshots (id, name, created_at, packs, notes) VALUES (?, ?, ?, ?, ?)'
    )
    .run(s.id, s.name, s.createdAt, JSON.stringify(s.packs), s.notes)
}

export function deleteSnapshot(id: string): boolean {
  return getDb().prepare('DELETE FROM node_snapshots WHERE id = ?').run(id).changes > 0
}

export function getSnapshot(id: string): NodeSnapshot | null {
  const r = getDb().prepare('SELECT * FROM node_snapshots WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    id: String(r.id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    packs: JSON.parse(String(r.packs || '[]')),
    notes: String(r.notes || '')
  }
}

// ---------- Workflows ----------
export function listWorkflows(): WorkflowRecord[] {
  const rows = getDb().prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    format: String(r.format) as WorkflowRecord['format'],
    nodeCount: Number(r.node_count || 0),
    tags: JSON.parse(String(r.tags || '[]')),
    description: r.description ? String(r.description) : undefined,
    updatedAt: Number(r.updated_at || 0),
    thumbnail: r.thumbnail ? String(r.thumbnail) : undefined,
    missingNodes: JSON.parse(String(r.missing_nodes || '[]')),
    version: String(r.version || '1.0'),
    seed: r.seed != null ? Number(r.seed) : undefined,
    modelUsed: r.model_used ? String(r.model_used) : undefined,
    params: JSON.parse(String(r.params || '{}'))
  }))
}

export function upsertWorkflow(w: WorkflowRecord): void {
  getDb()
    .prepare(
      `INSERT INTO workflows (id, name, path, format, node_count, tags, description, updated_at, thumbnail, missing_nodes, version, seed, model_used, params)
       VALUES (@id, @name, @path, @format, @nodeCount, @tags, @description, @updatedAt, @thumbnail, @missingNodes, @version, @seed, @modelUsed, @params)
       ON CONFLICT(path) DO UPDATE SET
         name=excluded.name, format=excluded.format, node_count=excluded.node_count, tags=excluded.tags,
         description=excluded.description, updated_at=excluded.updated_at, thumbnail=excluded.thumbnail,
         missing_nodes=excluded.missing_nodes, version=excluded.version, seed=excluded.seed,
         model_used=excluded.model_used, params=excluded.params`
    )
    .run({
      id: w.id,
      name: w.name,
      path: w.path,
      format: w.format,
      nodeCount: w.nodeCount,
      tags: JSON.stringify(w.tags || []),
      description: w.description || null,
      updatedAt: w.updatedAt,
      thumbnail: w.thumbnail || null,
      missingNodes: JSON.stringify(w.missingNodes || []),
      version: w.version || '1.0',
      seed: w.seed ?? null,
      modelUsed: w.modelUsed || null,
      params: JSON.stringify(w.params || {})
    })
}

// ---------- Downloads ----------
export function listDownloadTasks(): DownloadTask[] {
  const rows = getDb().prepare('SELECT * FROM downloads ORDER BY started_at DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    id: String(r.id),
    url: String(r.url),
    destPath: String(r.dest_path),
    fileName: String(r.file_name),
    totalBytes: Number(r.total_bytes || 0),
    receivedBytes: Number(r.received_bytes || 0),
    status: String(r.status) as DownloadTask['status'],
    error: r.error ? String(r.error) : undefined,
    startedAt: Number(r.started_at || 0),
    finishedAt: r.finished_at ? Number(r.finished_at) : undefined,
    source: String(r.source || 'direct') as DownloadTask['source']
  }))
}

export function upsertDownloadTask(t: DownloadTask): void {
  getDb()
    .prepare(
      `INSERT INTO downloads (id, url, dest_path, file_name, total_bytes, received_bytes, status, error, started_at, finished_at, source)
       VALUES (@id, @url, @destPath, @fileName, @totalBytes, @receivedBytes, @status, @error, @startedAt, @finishedAt, @source)
       ON CONFLICT(id) DO UPDATE SET
         total_bytes=excluded.total_bytes, received_bytes=excluded.received_bytes,
         status=excluded.status, error=excluded.error, finished_at=excluded.finished_at`
    )
    .run({
      id: t.id,
      url: t.url,
      destPath: t.destPath,
      fileName: t.fileName,
      totalBytes: t.totalBytes,
      receivedBytes: t.receivedBytes,
      status: t.status,
      error: t.error || null,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt || null,
      source: t.source
    })
}

// ---------- Batch ----------
export function listBatchJobs(): BatchJob[] {
  const rows = getDb().prepare('SELECT * FROM batch_jobs ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    workflowPath: String(r.workflow_path),
    instanceId: String(r.instance_id),
    count: Number(r.count || 1),
    status: String(r.status) as BatchJob['status'],
    completed: Number(r.completed || 0),
    failed: Number(r.failed || 0),
    createdAt: Number(r.created_at || 0),
    finishedAt: r.finished_at ? Number(r.finished_at) : undefined,
    promptIds: JSON.parse(String(r.prompt_ids || '[]')),
    notes: String(r.notes || '')
  }))
}

export function upsertBatchJob(j: BatchJob): void {
  getDb()
    .prepare(
      `INSERT INTO batch_jobs (id, name, workflow_path, instance_id, count, status, completed, failed, created_at, finished_at, prompt_ids, notes)
       VALUES (@id, @name, @workflowPath, @instanceId, @count, @status, @completed, @failed, @createdAt, @finishedAt, @promptIds, @notes)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, completed=excluded.completed, failed=excluded.failed,
         finished_at=excluded.finished_at, prompt_ids=excluded.prompt_ids, notes=excluded.notes`
    )
    .run({
      id: j.id,
      name: j.name,
      workflowPath: j.workflowPath,
      instanceId: j.instanceId,
      count: j.count,
      status: j.status,
      completed: j.completed,
      failed: j.failed,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt || null,
      promptIds: JSON.stringify(j.promptIds || []),
      notes: j.notes || ''
    })
}

export function deleteBatchJob(id: string): boolean {
  return getDb().prepare('DELETE FROM batch_jobs WHERE id = ?').run(id).changes > 0
}

// ---------- Backups ----------
export function listBackups(): BackupManifest[] {
  const rows = getDb().prepare('SELECT * FROM backups ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    path: String(r.path),
    size: Number(r.size || 0),
    includes: JSON.parse(String(r.includes || '{}')),
    notes: String(r.notes || '')
  }))
}

export function insertBackup(b: BackupManifest): void {
  getDb()
    .prepare(
      'INSERT INTO backups (id, name, created_at, path, size, includes, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(b.id, b.name, b.createdAt, b.path, b.size, JSON.stringify(b.includes), b.notes)
}

export function deleteBackup(id: string): boolean {
  return getDb().prepare('DELETE FROM backups WHERE id = ?').run(id).changes > 0
}

// ---------- Output ----------
export function upsertOutputAsset(a: OutputAsset): void {
  getDb()
    .prepare(
      `INSERT INTO output_assets (id, path, file_name, type, size, created_at, width, height, workflow_id, prompt_id, seed, params, thumbnail)
       VALUES (@id, @path, @fileName, @type, @size, @createdAt, @width, @height, @workflowId, @promptId, @seed, @params, @thumbnail)
       ON CONFLICT(path) DO UPDATE SET
         size=excluded.size, created_at=excluded.created_at, width=excluded.width, height=excluded.height,
         workflow_id=excluded.workflow_id, prompt_id=excluded.prompt_id, seed=excluded.seed,
         params=excluded.params, thumbnail=excluded.thumbnail`
    )
    .run({
      id: a.id,
      path: a.path,
      fileName: a.fileName,
      type: a.type,
      size: a.size,
      createdAt: a.createdAt,
      width: a.width ?? null,
      height: a.height ?? null,
      workflowId: a.workflowId ?? null,
      promptId: a.promptId ?? null,
      seed: a.seed ?? null,
      params: JSON.stringify(a.params || {}),
      thumbnail: a.thumbnail ?? null
    })
}

export function listOutputAssets(limit = 200): OutputAsset[] {
  const rows = getDb()
    .prepare('SELECT * FROM output_assets ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: String(r.id),
    path: String(r.path),
    fileName: String(r.file_name),
    type: String(r.type) as OutputAsset['type'],
    size: Number(r.size || 0),
    createdAt: Number(r.created_at || 0),
    width: r.width ? Number(r.width) : undefined,
    height: r.height ? Number(r.height) : undefined,
    workflowId: r.workflow_id ? String(r.workflow_id) : undefined,
    promptId: r.prompt_id ? String(r.prompt_id) : undefined,
    seed: r.seed != null ? Number(r.seed) : undefined,
    params: JSON.parse(String(r.params || '{}')),
    thumbnail: r.thumbnail ? String(r.thumbnail) : undefined
  }))
}

// ---------- Remote ----------
export function listRemotes(): RemoteInstanceConfig[] {
  const rows = getDb().prepare('SELECT * FROM remote_instances').all() as Array<
    Record<string, unknown>
  >
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    baseUrl: String(r.base_url),
    apiKey: r.api_key ? String(r.api_key) : undefined,
    label: String(r.label || ''),
    enabled: Boolean(r.enabled)
  }))
}

export function upsertRemote(c: RemoteInstanceConfig): void {
  getDb()
    .prepare(
      `INSERT INTO remote_instances (id, name, base_url, api_key, label, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url,
         api_key=excluded.api_key, label=excluded.label, enabled=excluded.enabled`
    )
    .run(c.id, c.name, c.baseUrl, c.apiKey || null, c.label, c.enabled ? 1 : 0)
}

export function deleteRemote(id: string): boolean {
  return getDb().prepare('DELETE FROM remote_instances WHERE id = ?').run(id).changes > 0
}

export function newId(): string {
  return randomUUID()
}
