"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const events = require("events");
const child_process = require("child_process");
const util = require("util");
const net = require("net");
const os = require("os");
const jsYaml = require("js-yaml");
const si = require("systeminformation");
const WebSocket = require("ws");
function sanitizeId(id, fallback = "") {
  const cleaned = String(id || "").replace(/[^\w.-]/g, "_").replace(/\.\.+/g, "_").slice(0, 120);
  if (!cleaned || /^\.+$/.test(cleaned)) return fallback || crypto.randomUUID();
  return cleaned;
}
function assertSafeRelativeFilename(name) {
  const raw = String(name || "").trim();
  if (!raw || /^[.]+$/.test(raw)) throw new Error("Empty filename");
  const cleaned = raw.replace(/[\\/]/g, "_").replace(/\.{2,}/g, "_").replace(/[^\w.\- ]/g, "_").trim();
  if (!cleaned || cleaned === "." || /^[_]+$/.test(cleaned)) throw new Error("Empty filename");
  return cleaned.slice(0, 180);
}
function normalizePathSegment(segment) {
  return String(segment || "").replace(/[\x00-\x1f]/g, "").replace(/[. ]+$/g, "").replace(/^[. ]+/, "");
}
function normalizePathEverySegment(pathStr) {
  const raw = String(pathStr || "");
  let prefix = "";
  let rest = raw;
  const drive = raw.match(/^([a-zA-Z]:)(.*)$/);
  if (drive) {
    prefix = drive[1];
    rest = drive[2];
  }
  const sep2 = rest.includes("\\") && !rest.includes("/") ? "\\" : "/";
  const parts = rest.split(/[\\/]+/);
  const cleaned = [];
  for (const p of parts) {
    if (!p) continue;
    if (/\.{2,}/.test(p)) {
      cleaned.push("..");
      continue;
    }
    const n = normalizePathSegment(p);
    if (!n || n === ".") continue;
    cleaned.push(n);
  }
  const joined = cleaned.join(sep2);
  const hadRootSep = /^[\\/]/.test(rest);
  if (prefix) {
    return prefix + sep2 + joined;
  }
  if (hadRootSep) {
    return sep2 + joined;
  }
  return joined;
}
function hasParentHop(pathStr) {
  return normalizePathEverySegment(pathStr).split(/[\\/]+/).some((s) => s === "..");
}
function isPathInside(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  return resolvedChild.startsWith(resolvedParent.endsWith(path.sep) ? resolvedParent : resolvedParent + path.sep);
}
function safeResolveUnder(appRoot, relative) {
  try {
    let decoded = String(relative || "");
    for (let i = 0; i < 4 && decoded.includes("%"); i++) {
      decoded = decodeURIComponent(decoded);
    }
    decoded = decoded.replace(/^[/\\]+/, "");
    if (decoded.includes("\0") || decoded.includes("%")) return null;
    if (/^[a-zA-Z]:/.test(decoded)) return null;
    if (hasParentHop(decoded)) return null;
    const normalized = normalizePathEverySegment(decoded);
    if (!normalized) return null;
    const target = path.resolve(appRoot, normalized);
    return isPathInside(target, appRoot) ? target : null;
  } catch {
    return null;
  }
}
function resolveInsideAnyRoot(candidate, roots) {
  if (!candidate) return null;
  if (hasParentHop(candidate)) return null;
  try {
    const normalized = normalizePathEverySegment(candidate);
    const target = path.resolve(normalized);
    for (const root of roots) {
      if (!root) continue;
      const r = path.resolve(root);
      if (target === r || isPathInside(target, r)) return target;
    }
    return null;
  } catch {
    return null;
  }
}
const SAFE_EXTERNAL_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:", "mailto:"]);
function isSafeExternalUrl(raw) {
  try {
    const u = new URL(raw);
    return SAFE_EXTERNAL_PROTOCOLS.has(u.protocol);
  } catch {
    return false;
  }
}
function isSafeEmbedUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return true;
  } catch {
    return false;
  }
}
function isLocalhostUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === "http:" || u.protocol === "https:" ? host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" : false;
  } catch {
    return false;
  }
}
const BLOCKED_OPEN_EXTENSIONS = /* @__PURE__ */ new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".msi",
  ".msp",
  ".mst",
  ".hta",
  ".jar",
  ".cpl",
  ".reg",
  ".lnk",
  ".url",
  ".pif",
  ".application",
  ".gadget"
]);
function isSafeOpenPath(path$1) {
  if (!path$1) return false;
  if (path$1.includes("\0")) return false;
  const seg = normalizePathSegment(path.basename(path$1));
  const ext = path.extname(seg).toLowerCase();
  if (BLOCKED_OPEN_EXTENSIONS.has(ext)) return false;
  return true;
}
const security = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  assertSafeRelativeFilename,
  basename: path.basename,
  dirname: path.dirname,
  extname: path.extname,
  hasParentHop,
  isLocalhostUrl,
  isPathInside,
  isSafeEmbedUrl,
  isSafeExternalUrl,
  isSafeOpenPath,
  normalizePathEverySegment,
  normalizePathSegment,
  resolveInsideAnyRoot,
  safeResolveUnder,
  sanitizeId
}, Symbol.toStringTag, { value: "Module" }));
const APP_NAME = "ComfyPilot";
const DEFAULT_SETTINGS = {
  theme: "light",
  locale: "zh-CN",
  defaultInstancePath: "",
  extraModelPathsFile: "",
  modelScanRoots: [],
  downloadDir: "",
  githubEndpoint: "",
  hfEndpoint: "",
  civitaiEndpoint: "https://civitai.com",
  enableAutoCheckUpdates: true,
  embedFrontend: true,
  securityLevel: "normal",
  allowGitUrlInstall: false,
  allowPipInstall: false,
  networkMode: "public",
  aria2Path: "",
  useAria2: false,
  outputIndexRoot: "",
  remoteInstances: [],
  proxy: {
    enabled: false,
    protocol: "http",
    host: "",
    port: 7890,
    username: "",
    password: "",
    bypass: "localhost,127.0.0.1,::1"
  }
};
const COMFY_DEFAULT_PORTS = [8188, 8189, 8190, 8191, 8192, 8288, 8388];
const LAUNCH_TEMPLATES = [
  {
    id: "default",
    name: "默认本地",
    args: [],
    description: "仅监听 127.0.0.1，适合日常使用"
  },
  {
    id: "preview-taesd",
    name: "高质量预览",
    args: ["--preview-method", "taesd", "--preview-size", "512"],
    description: "启用 TAESD 高清预览（需 models/vae_approx）"
  },
  {
    id: "manager",
    name: "启用 Manager",
    args: ["--enable-manager"],
    description: "启用 ComfyUI-Manager 后台能力"
  },
  {
    id: "offline",
    name: "完全离线",
    args: ["--offline"],
    description: "禁用付费 API 节点，强制离线"
  },
  {
    id: "lan",
    name: "局域网共享",
    args: ["--listen", "0.0.0.0"],
    description: "监听所有网卡（注意安全）"
  },
  {
    id: "lowvram",
    name: "低显存",
    args: ["--lowvram"],
    description: "低显存优化加载"
  },
  {
    id: "cpu",
    name: "CPU 模式",
    args: ["--cpu"],
    description: "强制使用 CPU 推理"
  }
];
const REGISTRY_API = "https://api.comfy.org";
let db = null;
let loadError = null;
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function userDataDir() {
  return ensureDir(path.join(electron.app.getPath("userData"), "data"));
}
function cacheDir() {
  return ensureDir(path.join(electron.app.getPath("userData"), "cache"));
}
function logsDir() {
  return ensureDir(path.join(electron.app.getPath("userData"), "logs"));
}
function backupDir() {
  return ensureDir(path.join(userDataDir(), "backups"));
}
function snapshotDir() {
  return ensureDir(path.join(userDataDir(), "node-snapshots"));
}
function getDb() {
  if (db) return db;
  if (loadError) throw loadError;
  try {
    const BetterSqlite3 = require("better-sqlite3");
    const file = path.join(userDataDir(), "comfy-pilot.sqlite");
    db = new BetterSqlite3(file);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return db;
  } catch (err) {
    loadError = err instanceof Error ? err : new Error(String(err));
    throw loadError;
  }
}
function migrate(d) {
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
  `);
}
function loadSettings() {
  const d = getDb();
  const rows = d.prepare("SELECT key, value FROM settings").all();
  const map = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return {
    ...DEFAULT_SETTINGS,
    ...map,
    proxy: { ...DEFAULT_SETTINGS.proxy, ...map.proxy || {} }
  };
}
function saveSettings(patch) {
  const d = getDb();
  const current = loadSettings();
  const next = {
    ...current,
    ...patch,
    proxy: { ...current.proxy, ...patch.proxy || {} }
  };
  const upsert = d.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const tx = d.transaction((entries) => {
    for (const [k, v] of entries) upsert.run(k, JSON.stringify(v));
  });
  tx(Object.entries(next).map(([k, v]) => [k, v]));
  return next;
}
function loadInstanceConfigs() {
  const d = getDb();
  const rows = d.prepare("SELECT * FROM instances").all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    pythonPath: String(r.python_path || ""),
    venvPath: String(r.venv_path || ""),
    port: Number(r.port || 8188),
    listen: String(r.listen || "127.0.0.1"),
    extraArgs: JSON.parse(String(r.extra_args || "[]")),
    argTemplateId: String(r.arg_template_id || ""),
    enabled: Boolean(r.enabled),
    notes: String(r.notes || ""),
    autoStart: Boolean(r.auto_start),
    frontendVersion: String(r.frontend_version || "")
  }));
}
function upsertInstanceConfig(config) {
  const d = getDb();
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
    pythonPath: config.pythonPath || "",
    venvPath: config.venvPath || "",
    port: config.port || 8188,
    listen: config.listen || "127.0.0.1",
    extraArgs: JSON.stringify(config.extraArgs || []),
    argTemplateId: config.argTemplateId || "",
    enabled: config.enabled ? 1 : 0,
    notes: config.notes || "",
    autoStart: config.autoStart ? 1 : 0,
    frontendVersion: config.frontendVersion || ""
  });
}
function deleteInstanceConfig(id) {
  const res = getDb().prepare("DELETE FROM instances WHERE id = ?").run(id);
  return res.changes > 0;
}
function rowToModel(r) {
  return {
    id: String(r.id),
    name: String(r.name),
    fileName: String(r.file_name),
    category: String(r.category),
    path: String(r.path),
    size: Number(r.size || 0),
    hashSha256: r.hash_sha256 ? String(r.hash_sha256) : void 0,
    modifiedAt: Number(r.modified_at || 0),
    architecture: r.architecture ? String(r.architecture) : void 0,
    source: String(r.source || "local"),
    thumbnail: r.thumbnail ? String(r.thumbnail) : void 0,
    tags: JSON.parse(String(r.tags || "[]")),
    metadata: JSON.parse(String(r.metadata || "{}")),
    baseModel: r.base_model ? String(r.base_model) : void 0,
    trainedWords: JSON.parse(String(r.trained_words || "[]")),
    duplicateOf: r.duplicate_of ? String(r.duplicate_of) : void 0,
    pathRoot: String(r.path_root || "")
  };
}
function upsertModel(m) {
  getDb().prepare(
    `INSERT INTO models (id, name, file_name, category, path, size, hash_sha256, modified_at, architecture, source, thumbnail, tags, metadata, base_model, trained_words, duplicate_of, path_root)
       VALUES (@id, @name, @fileName, @category, @path, @size, @hashSha256, @modifiedAt, @architecture, @source, @thumbnail, @tags, @metadata, @baseModel, @trainedWords, @duplicateOf, @pathRoot)
       ON CONFLICT(path) DO UPDATE SET
         name=excluded.name, file_name=excluded.file_name, category=excluded.category, size=excluded.size,
         hash_sha256=COALESCE(excluded.hash_sha256, models.hash_sha256), modified_at=excluded.modified_at,
         architecture=excluded.architecture, source=excluded.source, thumbnail=excluded.thumbnail,
         tags=excluded.tags, metadata=excluded.metadata, base_model=excluded.base_model,
         trained_words=excluded.trained_words, duplicate_of=excluded.duplicate_of, path_root=excluded.path_root`
  ).run({
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
    pathRoot: m.pathRoot || ""
  });
}
function listModels() {
  const rows = getDb().prepare("SELECT * FROM models ORDER BY modified_at DESC").all();
  return rows.map(rowToModel);
}
function deleteModel(id) {
  return getDb().prepare("DELETE FROM models WHERE id = ?").run(id).changes > 0;
}
function findModelByPath(path2) {
  const r = getDb().prepare("SELECT * FROM models WHERE path = ?").get(path2);
  return r ? rowToModel(r) : null;
}
function updateModel(id, patch) {
  const fields = [];
  const values = { id };
  if (patch.name !== void 0) {
    fields.push("name = @name");
    values.name = patch.name;
  }
  if (patch.tags !== void 0) {
    fields.push("tags = @tags");
    values.tags = JSON.stringify(patch.tags);
  }
  if (patch.hashSha256 !== void 0) {
    fields.push("hash_sha256 = @hashSha256");
    values.hashSha256 = patch.hashSha256;
  }
  if (patch.duplicateOf !== void 0) {
    fields.push("duplicate_of = @duplicateOf");
    values.duplicateOf = patch.duplicateOf;
  }
  if (!fields.length) return;
  getDb().prepare(`UPDATE models SET ${fields.join(", ")} WHERE id = @id`).run(values);
}
function rowToNodePack(r) {
  return {
    id: String(r.id),
    name: String(r.name),
    displayName: String(r.display_name || r.name),
    description: String(r.description || ""),
    author: String(r.author || ""),
    version: String(r.version || "0.0.0"),
    latestVersion: r.latest_version ? String(r.latest_version) : void 0,
    status: String(r.status || "installed"),
    path: r.path ? String(r.path) : void 0,
    repository: r.repository ? String(r.repository) : void 0,
    registryId: r.registry_id ? String(r.registry_id) : void 0,
    nodeCount: Number(r.node_count || 0),
    tags: JSON.parse(String(r.tags || "[]")),
    pythonCompatible: r.python_compatible ? String(r.python_compatible) : void 0,
    installSource: String(r.install_source || "local"),
    lastCheckedAt: r.last_checked_at ? Number(r.last_checked_at) : void 0,
    issues: JSON.parse(String(r.issues || "[]")),
    locked: Boolean(r.locked),
    nodeList: JSON.parse(String(r.node_list || "[]")),
    license: r.license ? String(r.license) : void 0,
    icon: r.icon ? String(r.icon) : void 0
  };
}
function upsertNodePack(p) {
  getDb().prepare(
    `INSERT INTO node_packs (id, name, display_name, description, author, version, latest_version, status, path, repository, registry_id, node_count, tags, python_compatible, install_source, last_checked_at, issues, locked, node_list, license, icon)
       VALUES (@id, @name, @displayName, @description, @author, @version, @latestVersion, @status, @path, @repository, @registryId, @nodeCount, @tags, @pythonCompatible, @installSource, @lastCheckedAt, @issues, @locked, @nodeList, @license, @icon)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, display_name=excluded.display_name, description=excluded.description,
         author=excluded.author, version=excluded.version, latest_version=excluded.latest_version,
         status=excluded.status, path=excluded.path, repository=excluded.repository, registry_id=excluded.registry_id,
         node_count=excluded.node_count, tags=excluded.tags, python_compatible=excluded.python_compatible,
         install_source=excluded.install_source, last_checked_at=excluded.last_checked_at, issues=excluded.issues,
         locked=excluded.locked, node_list=excluded.node_list, license=excluded.license, icon=excluded.icon`
  ).run({
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
  });
}
function listNodePacks() {
  const rows = getDb().prepare("SELECT * FROM node_packs").all();
  return rows.map(rowToNodePack);
}
function deleteNodePack(id) {
  return getDb().prepare("DELETE FROM node_packs WHERE id = ?").run(id).changes > 0;
}
function listSnapshots() {
  const rows = getDb().prepare("SELECT * FROM node_snapshots ORDER BY created_at DESC").all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    packs: JSON.parse(String(r.packs || "[]")),
    notes: String(r.notes || "")
  }));
}
function insertSnapshot(s) {
  getDb().prepare(
    "INSERT INTO node_snapshots (id, name, created_at, packs, notes) VALUES (?, ?, ?, ?, ?)"
  ).run(s.id, s.name, s.createdAt, JSON.stringify(s.packs), s.notes);
}
function deleteSnapshot(id) {
  return getDb().prepare("DELETE FROM node_snapshots WHERE id = ?").run(id).changes > 0;
}
function getSnapshot(id) {
  const r = getDb().prepare("SELECT * FROM node_snapshots WHERE id = ?").get(id);
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    packs: JSON.parse(String(r.packs || "[]")),
    notes: String(r.notes || "")
  };
}
function listWorkflows() {
  const rows = getDb().prepare("SELECT * FROM workflows ORDER BY updated_at DESC").all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    format: String(r.format),
    nodeCount: Number(r.node_count || 0),
    tags: JSON.parse(String(r.tags || "[]")),
    description: r.description ? String(r.description) : void 0,
    updatedAt: Number(r.updated_at || 0),
    thumbnail: r.thumbnail ? String(r.thumbnail) : void 0,
    missingNodes: JSON.parse(String(r.missing_nodes || "[]")),
    version: String(r.version || "1.0"),
    seed: r.seed != null ? Number(r.seed) : void 0,
    modelUsed: r.model_used ? String(r.model_used) : void 0,
    params: JSON.parse(String(r.params || "{}"))
  }));
}
function upsertWorkflow(w) {
  getDb().prepare(
    `INSERT INTO workflows (id, name, path, format, node_count, tags, description, updated_at, thumbnail, missing_nodes, version, seed, model_used, params)
       VALUES (@id, @name, @path, @format, @nodeCount, @tags, @description, @updatedAt, @thumbnail, @missingNodes, @version, @seed, @modelUsed, @params)
       ON CONFLICT(path) DO UPDATE SET
         name=excluded.name, format=excluded.format, node_count=excluded.node_count, tags=excluded.tags,
         description=excluded.description, updated_at=excluded.updated_at, thumbnail=excluded.thumbnail,
         missing_nodes=excluded.missing_nodes, version=excluded.version, seed=excluded.seed,
         model_used=excluded.model_used, params=excluded.params`
  ).run({
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
    version: w.version || "1.0",
    seed: w.seed ?? null,
    modelUsed: w.modelUsed || null,
    params: JSON.stringify(w.params || {})
  });
}
function listDownloadTasks() {
  const rows = getDb().prepare("SELECT * FROM downloads ORDER BY started_at DESC").all();
  return rows.map((r) => ({
    id: String(r.id),
    url: String(r.url),
    destPath: String(r.dest_path),
    fileName: String(r.file_name),
    totalBytes: Number(r.total_bytes || 0),
    receivedBytes: Number(r.received_bytes || 0),
    status: String(r.status),
    error: r.error ? String(r.error) : void 0,
    startedAt: Number(r.started_at || 0),
    finishedAt: r.finished_at ? Number(r.finished_at) : void 0,
    source: String(r.source || "direct")
  }));
}
function upsertDownloadTask(t) {
  getDb().prepare(
    `INSERT INTO downloads (id, url, dest_path, file_name, total_bytes, received_bytes, status, error, started_at, finished_at, source)
       VALUES (@id, @url, @destPath, @fileName, @totalBytes, @receivedBytes, @status, @error, @startedAt, @finishedAt, @source)
       ON CONFLICT(id) DO UPDATE SET
         total_bytes=excluded.total_bytes, received_bytes=excluded.received_bytes,
         status=excluded.status, error=excluded.error, finished_at=excluded.finished_at`
  ).run({
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
  });
}
function listBatchJobs() {
  const rows = getDb().prepare("SELECT * FROM batch_jobs ORDER BY created_at DESC").all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    workflowPath: String(r.workflow_path),
    instanceId: String(r.instance_id),
    count: Number(r.count || 1),
    status: String(r.status),
    completed: Number(r.completed || 0),
    failed: Number(r.failed || 0),
    createdAt: Number(r.created_at || 0),
    finishedAt: r.finished_at ? Number(r.finished_at) : void 0,
    promptIds: JSON.parse(String(r.prompt_ids || "[]")),
    notes: String(r.notes || "")
  }));
}
function upsertBatchJob(j) {
  getDb().prepare(
    `INSERT INTO batch_jobs (id, name, workflow_path, instance_id, count, status, completed, failed, created_at, finished_at, prompt_ids, notes)
       VALUES (@id, @name, @workflowPath, @instanceId, @count, @status, @completed, @failed, @createdAt, @finishedAt, @promptIds, @notes)
       ON CONFLICT(id) DO UPDATE SET
         status=excluded.status, completed=excluded.completed, failed=excluded.failed,
         finished_at=excluded.finished_at, prompt_ids=excluded.prompt_ids, notes=excluded.notes`
  ).run({
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
    notes: j.notes || ""
  });
}
function deleteBatchJob(id) {
  return getDb().prepare("DELETE FROM batch_jobs WHERE id = ?").run(id).changes > 0;
}
function listBackups() {
  const rows = getDb().prepare("SELECT * FROM backups ORDER BY created_at DESC").all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    createdAt: Number(r.created_at),
    path: String(r.path),
    size: Number(r.size || 0),
    includes: JSON.parse(String(r.includes || "{}")),
    notes: String(r.notes || "")
  }));
}
function insertBackup(b) {
  getDb().prepare(
    "INSERT INTO backups (id, name, created_at, path, size, includes, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(b.id, b.name, b.createdAt, b.path, b.size, JSON.stringify(b.includes), b.notes);
}
function deleteBackup(id) {
  return getDb().prepare("DELETE FROM backups WHERE id = ?").run(id).changes > 0;
}
function upsertOutputAsset(a) {
  getDb().prepare(
    `INSERT INTO output_assets (id, path, file_name, type, size, created_at, width, height, workflow_id, prompt_id, seed, params, thumbnail)
       VALUES (@id, @path, @fileName, @type, @size, @createdAt, @width, @height, @workflowId, @promptId, @seed, @params, @thumbnail)
       ON CONFLICT(path) DO UPDATE SET
         size=excluded.size, created_at=excluded.created_at, width=excluded.width, height=excluded.height,
         workflow_id=excluded.workflow_id, prompt_id=excluded.prompt_id, seed=excluded.seed,
         params=excluded.params, thumbnail=excluded.thumbnail`
  ).run({
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
  });
}
function listOutputAssets(limit = 200) {
  const rows = getDb().prepare("SELECT * FROM output_assets ORDER BY created_at DESC LIMIT ?").all(limit);
  return rows.map((r) => ({
    id: String(r.id),
    path: String(r.path),
    fileName: String(r.file_name),
    type: String(r.type),
    size: Number(r.size || 0),
    createdAt: Number(r.created_at || 0),
    width: r.width ? Number(r.width) : void 0,
    height: r.height ? Number(r.height) : void 0,
    workflowId: r.workflow_id ? String(r.workflow_id) : void 0,
    promptId: r.prompt_id ? String(r.prompt_id) : void 0,
    seed: r.seed != null ? Number(r.seed) : void 0,
    params: JSON.parse(String(r.params || "{}")),
    thumbnail: r.thumbnail ? String(r.thumbnail) : void 0
  }));
}
function listRemotes() {
  const rows = getDb().prepare("SELECT * FROM remote_instances").all();
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    baseUrl: String(r.base_url),
    apiKey: r.api_key ? String(r.api_key) : void 0,
    label: String(r.label || ""),
    enabled: Boolean(r.enabled)
  }));
}
function upsertRemote(c) {
  getDb().prepare(
    `INSERT INTO remote_instances (id, name, base_url, api_key, label, enabled)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url,
         api_key=excluded.api_key, label=excluded.label, enabled=excluded.enabled`
  ).run(c.id, c.name, c.baseUrl, c.apiKey || null, c.label, c.enabled ? 1 : 0);
}
function deleteRemote(id) {
  return getDb().prepare("DELETE FROM remote_instances WHERE id = ?").run(id).changes > 0;
}
const execFileAsync$3 = util.promisify(child_process.execFile);
const LOG_CAP = 5e3;
class InstanceService extends events.EventEmitter {
  runtimes = /* @__PURE__ */ new Map();
  startingIds = /* @__PURE__ */ new Set();
  ensureRuntime(config) {
    let rt = this.runtimes.get(config.id);
    if (!rt) {
      rt = { config, status: "stopped", logs: [], generation: 0, intentionalStop: false };
      this.runtimes.set(config.id, rt);
    } else {
      rt.config = config;
    }
    return rt;
  }
  pushLog(rt, level, message) {
    const line = { ts: Date.now(), level, message, source: "comfy" };
    rt.logs.push(line);
    if (rt.logs.length > LOG_CAP) rt.logs.splice(0, rt.logs.length - LOG_CAP);
    this.emit("log", rt.config.id, line);
    this.emitStatus(rt);
    this.appendLogFile(rt.config.id, line);
  }
  appendLogFile(id, line) {
    try {
      const file = path.join(logsDir(), `${id}.log`);
      fs.writeFileSync(file, `[${new Date(line.ts).toISOString()}] ${line.level.toUpperCase()} ${line.message}
`, {
        flag: "a"
      });
    } catch {
    }
  }
  emitStatus(rt) {
    this.emit("status", this.toInfo(rt));
  }
  versionCache = /* @__PURE__ */ new Map();
  probeVersion(installPath) {
    if (this.versionCache.has(installPath)) return this.versionCache.get(installPath);
    let version;
    try {
      const pyproject = path.join(installPath, "pyproject.toml");
      if (fs.existsSync(pyproject)) {
        const text = fs.readFileSync(pyproject, "utf-8");
        const m = text.match(/version\s*=\s*["']([^"']+)["']/);
        if (m) version = m[1];
      }
      if (!version && fs.existsSync(path.join(installPath, "requirements.txt"))) version = "detected";
    } catch {
    }
    this.versionCache.set(installPath, version);
    return version;
  }
  toInfo(rt) {
    const port = rt.config.port || 8188;
    const listen = rt.config.listen || "127.0.0.1";
    return {
      ...rt.config,
      status: rt.status,
      pid: rt.pid,
      url: `http://${listen === "0.0.0.0" ? "127.0.0.1" : listen}:${port}`,
      startedAt: rt.startedAt,
      uptimeMs: rt.startedAt ? Date.now() - rt.startedAt : void 0,
      lastError: rt.lastError,
      managerEnabled: rt.config.extraArgs?.some((a) => a.includes("enable-manager")),
      version: this.probeVersion(rt.config.path)
    };
  }
  list() {
    return loadInstanceConfigs().map((c) => this.toInfo(this.ensureRuntime(c)));
  }
  save(config) {
    const id = config.id || crypto.randomUUID();
    const next = { ...config, id };
    upsertInstanceConfig(next);
    return this.toInfo(this.ensureRuntime(next));
  }
  remove(id) {
    const rt = this.runtimes.get(id);
    if (rt?.process) {
      rt.intentionalStop = true;
      rt.generation += 1;
      try {
        rt.process.kill();
      } catch {
      }
      rt.process = void 0;
    }
    this.runtimes.delete(id);
    return deleteInstanceConfig(id);
  }
  commonRoots(extra) {
    const candidates = [
      extra,
      process.env.COMFYUI_PATH,
      "D:\\ComfyUI",
      "C:\\ComfyUI",
      "D:\\AI\\ComfyUI",
      path.join(process.env.USERPROFILE || "", "ComfyUI"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "comfyui-desktop")
    ].filter(Boolean);
    return [...new Set(candidates)];
  }
  discover(root) {
    const found = [];
    for (const p of this.commonRoots(root)) {
      if (!p || !fs.existsSync(p)) continue;
      let entries = [];
      try {
        entries = fs.readdirSync(p);
      } catch {
        continue;
      }
      this.scoreCandidate(p, found);
      for (const name of entries.slice(0, 40)) {
        const child = path.join(p, name);
        try {
          if (fs.statSync(child).isDirectory()) this.scoreCandidate(child, found);
        } catch {
        }
      }
    }
    return found.sort((a, b) => b.score - a.score).slice(0, 20);
  }
  scoreCandidate(path$1, out) {
    const hasMainPy = fs.existsSync(path.join(path$1, "main.py"));
    const hasRequirements = fs.existsSync(path.join(path$1, "requirements.txt"));
    const hasVenv = fs.existsSync(path.join(path$1, "venv")) || fs.existsSync(path.join(path$1, ".venv")) || fs.existsSync(path.join(path$1, "python_embeded")) || fs.existsSync(path.join(path$1, "python_embedded"));
    if (!hasMainPy && !hasRequirements) return;
    if (out.some((c) => c.path === path$1)) return;
    out.push({
      path: path$1,
      score: (hasMainPy ? 50 : 0) + (hasRequirements ? 20 : 0) + (hasVenv ? 30 : 0),
      reason: hasMainPy ? "Found main.py" : "Found requirements.txt",
      hasMainPy,
      hasRequirements,
      hasVenv,
      estimatedVersion: this.probeVersion(path$1)
    });
  }
  getLogs(id, limit = 500) {
    const rt = this.runtimes.get(id);
    return rt ? rt.logs.slice(-limit) : [];
  }
  clearLogs(id) {
    const rt = this.runtimes.get(id);
    if (!rt) return false;
    rt.logs = [];
    this.emitStatus(rt);
    return true;
  }
  async checkPort(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", (err) => {
        resolve({
          port,
          available: false,
          owner: err.code === "EADDRINUSE" ? "port in use" : err.message
        });
      });
      server.once("listening", () => {
        server.close(() => resolve({ port, available: true }));
      });
      server.listen(port, "127.0.0.1");
    });
  }
  async suggestPort() {
    for (const p of COMFY_DEFAULT_PORTS) {
      const check = await this.checkPort(p);
      if (check.available) return p;
    }
    return 9e3 + Math.floor(Math.random() * 500);
  }
  async probeEnv(id) {
    const configs = loadInstanceConfigs();
    const config = configs.find((c) => c.id === id);
    const pythonPath = config?.venvPath ? path.join(config.venvPath, "Scripts", "python.exe") : config?.pythonPath || "python";
    const errors = [];
    let pythonVersion = "";
    let torchVersion;
    let cudaVersion;
    let mpsAvailable;
    let npuAvailable;
    const packages = [];
    try {
      const { stdout } = await execFileAsync$3(pythonPath, ["--version"], { timeout: 8e3 });
      pythonVersion = stdout.trim() || await this.pyVersionFallback(pythonPath);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    try {
      const script = [
        "import torch, json",
        "print(json.dumps({",
        '"torch": getattr(torch, "__version__", ""),',
        '"cuda": getattr(torch.version, "cuda", None),',
        '"mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),',
        '"npu": bool(getattr(torch, "npu", None) and hasattr(torch.npu, "is_available") and torch.npu.is_available())',
        "}))"
      ].join(";");
      const { stdout } = await execFileAsync$3(pythonPath, ["-c", script], { timeout: 15e3 });
      const data = JSON.parse(stdout.trim().split("\n").pop() || "{}");
      torchVersion = data.torch;
      cudaVersion = data.cuda || void 0;
      mpsAvailable = Boolean(data.mps);
      npuAvailable = Boolean(data.npu);
      packages.push({ name: "torch", version: data.torch || "" });
    } catch (e) {
      errors.push("torch: " + (e instanceof Error ? e.message : String(e)));
    }
    try {
      const { stdout } = await execFileAsync$3(pythonPath, ["-m", "pip", "list", "--format=json"], {
        timeout: 2e4
      });
      const list = JSON.parse(stdout.trim());
      packages.push(...list.slice(0, 200));
    } catch {
    }
    return {
      pythonPath,
      pythonVersion,
      venvPath: config?.venvPath || void 0,
      torchVersion,
      cudaVersion,
      mpsAvailable,
      npuAvailable,
      packages,
      ok: errors.length === 0 && Boolean(pythonVersion),
      errors
    };
  }
  async pyVersionFallback(pythonPath) {
    try {
      const { stdout } = await execFileAsync$3(pythonPath, ["-c", "import sys; print(sys.version)"], {
        timeout: 8e3
      });
      return stdout.trim();
    } catch {
      return "";
    }
  }
  async exportDiagnostics(id) {
    const configs = loadInstanceConfigs();
    const config = configs.find((c) => c.id === id);
    const createdAt = Date.now();
    const dir = path.join(userDataDir(), "diagnostics", `${id}-${createdAt}`);
    fs.mkdirSync(dir, { recursive: true });
    const contents = [];
    fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify(config, null, 2));
    contents.push("instance.json");
    const rt = this.runtimes.get(id);
    const logs = rt?.logs || this.readLogFile(id);
    fs.writeFileSync(
      path.join(dir, "console.log"),
      logs.map((l) => `[${new Date(l.ts).toISOString()}] ${l.level} ${l.message}`).join("\n")
    );
    contents.push("console.log");
    try {
      const probe = await this.probeEnv(id);
      fs.writeFileSync(path.join(dir, "env.json"), JSON.stringify(probe, null, 2));
      contents.push("env.json");
    } catch {
    }
    if (config?.path) {
      const emp = path.join(config.path, "extra_model_paths.yaml");
      if (fs.existsSync(emp)) {
        fs.writeFileSync(path.join(dir, "extra_model_paths.yaml"), fs.readFileSync(emp, "utf-8"));
        contents.push("extra_model_paths.yaml");
      }
      const custom = path.join(config.path, "custom_nodes");
      if (fs.existsSync(custom)) {
        fs.writeFileSync(path.join(dir, "custom_nodes.txt"), fs.readdirSync(custom).join("\n"));
        contents.push("custom_nodes.txt");
      }
    }
    let size = 0;
    for (const f of contents) {
      try {
        size += fs.statSync(path.join(dir, f)).size;
      } catch {
      }
    }
    return { path: dir, createdAt, size, contents };
  }
  readLogFile(id) {
    try {
      const file = path.join(logsDir(), `${id}.log`);
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^\[([^\]]+)\]\s+(\w+)\s+(.*)$/);
        return {
          ts: m ? Date.parse(m[1]) : Date.now(),
          level: m?.[2]?.toLowerCase() || "info",
          message: m?.[3] || line
        };
      });
    } catch {
      return [];
    }
  }
  async copyDiagnostics(id) {
    const pkg = await this.exportDiagnostics(id);
    return pkg.path;
  }
  resolvePython(config) {
    if (config.venvPath) {
      const win = path.join(config.venvPath, "Scripts", "python.exe");
      const unix = path.join(config.venvPath, "bin", "python");
      if (fs.existsSync(win)) return win;
      if (fs.existsSync(unix)) return unix;
    }
    if (config.pythonPath) return config.pythonPath;
    const embed = path.join(config.path, "python_embeded", "python.exe");
    if (fs.existsSync(embed)) return embed;
    const embed2 = path.join(config.path, "python_embedded", "python.exe");
    if (fs.existsSync(embed2)) return embed2;
    return "python";
  }
  buildArgs(config) {
    const args = [
      path.join(config.path, "main.py"),
      "--port",
      String(config.port || 8188),
      "--listen",
      config.listen || "127.0.0.1"
    ];
    const template = LAUNCH_TEMPLATES.find((t) => t.id === config.argTemplateId);
    if (template) args.push(...template.args);
    const extra = Array.isArray(config.extraArgs) ? config.extraArgs : String(config.extraArgs || "").split(/\s+/).filter(Boolean);
    if (extra.length) args.push(...extra);
    return args;
  }
  async start(id) {
    if (this.startingIds.has(id)) {
      throw new Error("Instance start already in progress");
    }
    this.startingIds.add(id);
    try {
      return await this.startInner(id);
    } finally {
      this.startingIds.delete(id);
    }
  }
  async startInner(id) {
    const config = loadInstanceConfigs().find((c) => c.id === id);
    if (!config) throw new Error(`Instance not found: ${id}`);
    const rt = this.ensureRuntime(config);
    if (rt.process && rt.process.exitCode === null) return this.toInfo(rt);
    const portCheck = await this.checkPort(config.port || 8188);
    if (!portCheck.available) {
      rt.lastError = `Port ${config.port} is already in use`;
      rt.status = "error";
      this.pushLog(rt, "error", rt.lastError);
      throw new Error(rt.lastError);
    }
    rt.generation += 1;
    const gen = rt.generation;
    rt.intentionalStop = false;
    rt.status = "starting";
    rt.lastError = void 0;
    this.emitStatus(rt);
    const python = this.resolvePython(config);
    const args = this.buildArgs(config);
    try {
      const child = child_process.spawn(python, args, {
        cwd: config.path,
        windowsHide: true,
        env: { ...process.env }
      });
      rt.process = child;
      rt.pid = child.pid;
      rt.startedAt = Date.now();
      child.stdout.on("data", (buf) => {
        if (rt.generation !== gen) return;
        buf.toString("utf-8").split(/\r?\n/).filter(Boolean).forEach((line) => {
          const level = /error|traceback/i.test(line) ? "error" : /warn/i.test(line) ? "warn" : "info";
          this.pushLog(rt, level, line);
        });
      });
      child.stderr.on("data", (buf) => {
        if (rt.generation !== gen) return;
        buf.toString("utf-8").split(/\r?\n/).filter(Boolean).forEach(
          (line) => this.pushLog(rt, /error|traceback/i.test(line) ? "error" : "warn", line)
        );
      });
      child.on("error", (err) => {
        if (rt.generation !== gen) return;
        rt.lastError = err.message;
        rt.status = "error";
        if (rt.process === child) {
          rt.process = void 0;
          rt.pid = void 0;
        }
        this.pushLog(rt, "error", err.message);
      });
      child.on("exit", (code, signal) => {
        if (rt.generation !== gen) return;
        if (rt.process === child) {
          rt.process = void 0;
          rt.pid = void 0;
        }
        const intentional = rt.intentionalStop || signal === "SIGTERM" || signal === "SIGKILL";
        rt.status = intentional ? "stopped" : code === 0 ? "stopped" : "error";
        if (!intentional && code !== 0) rt.lastError = `Exited with code ${code}`;
        this.pushLog(rt, code === 0 || intentional ? "info" : "error", `Process exited code=${code} signal=${signal}`);
      });
      setTimeout(() => {
        if (rt.generation === gen && rt.process && rt.status === "starting") {
          rt.status = "running";
          this.pushLog(rt, "info", `ComfyUI listening at ${this.toInfo(rt).url}`);
        }
      }, 1500);
    } catch (err) {
      rt.status = "error";
      rt.lastError = err instanceof Error ? err.message : String(err);
      this.emitStatus(rt);
      throw err;
    }
    return this.toInfo(rt);
  }
  async stop(id) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`Instance not found: ${id}`);
    rt.intentionalStop = true;
    rt.generation += 1;
    const child = rt.process;
    rt.process = void 0;
    rt.pid = void 0;
    rt.status = "stopped";
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
        } catch {
        }
      }, 3e3);
    }
    this.emitStatus(rt);
    return this.toInfo(rt);
  }
  async restart(id) {
    await this.stop(id);
    const config = loadInstanceConfigs().find((c) => c.id === id);
    const port = config?.port || 8188;
    for (let i = 0; i < 20; i++) {
      const check = await this.checkPort(port);
      if (check.available) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.start(id);
  }
  async forceKill(id) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error(`Instance not found: ${id}`);
    rt.intentionalStop = true;
    rt.generation += 1;
    const child = rt.process;
    const pid = rt.pid;
    rt.process = void 0;
    rt.pid = void 0;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    } else if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }
    rt.status = "stopped";
    this.pushLog(rt, "warn", "Force killed");
    this.emitStatus(rt);
    return this.toInfo(rt);
  }
  stopAll() {
    for (const rt of this.runtimes.values()) {
      if (rt.process) {
        rt.intentionalStop = true;
        rt.generation += 1;
        try {
          rt.process.kill();
        } catch {
        }
        rt.process = void 0;
        rt.status = "stopped";
      }
    }
  }
}
const instanceService = new InstanceService();
function hashId(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}
const instance = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  InstanceService,
  dirname: path.dirname,
  hashId,
  instanceService,
  rmSync: fs.rmSync
}, Symbol.toStringTag, { value: "Module" }));
const MODEL_EXT = /* @__PURE__ */ new Set([".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx"]);
const CATEGORY_BY_DIR = {
  checkpoints: "checkpoints",
  diffusion_models: "diffusion_models",
  unet: "unet",
  loras: "loras",
  vae: "vae",
  clip: "clip",
  text_encoders: "text_encoders",
  controlnet: "controlnet",
  upscale_models: "upscale_models",
  embeddings: "embeddings",
  hypernetworks: "other",
  style_models: "other"
};
function categorize(path2) {
  const norm = path2.replace(/\\/g, "/").toLowerCase();
  for (const [key, cat] of Object.entries(CATEGORY_BY_DIR)) {
    if (norm.includes(`/${key}/`) || norm.includes(`\\${key}\\`)) return cat;
  }
  return "other";
}
function inferArchitecture(name) {
  const n = name.toLowerCase();
  if (n.includes("sdxl") || n.includes("xl-base")) return "SDXL";
  if (n.includes("sd3") || n.includes("sd-3")) return "SD3";
  if (n.includes("flux")) return "Flux";
  if (n.includes("wan")) return "Wan";
  if (n.includes("hunyuan") || n.includes("hyvideo")) return "Hunyuan";
  if (n.includes("qwen")) return "Qwen";
  if (n.includes("ltx")) return "LTX";
  if (n.includes("sd15") || n.includes("sd-1") || n.includes("v1-5")) return "SD1.5";
  return void 0;
}
function detectSourceFromPath(path2) {
  const p = path2.toLowerCase();
  if (p.includes("civitai")) return "civitai";
  if (p.includes("huggingface") || p.includes("hf_")) return "huggingface";
  return "local";
}
function parseExtraModelPaths(filePath, includeMissing = true) {
  const settings = loadSettings();
  const candidates = [filePath, settings.extraModelPathsFile].filter(Boolean);
  const roots = [];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const doc = jsYaml.load(readFileSyncSafe(file));
      if (!doc) continue;
      for (const section of Object.values(doc)) {
        if (!section || typeof section !== "object") continue;
        for (const [key, val] of Object.entries(section)) {
          if (key === "base_path" && typeof val === "string") roots.push(val);
          if ([
            "checkpoints",
            "loras",
            "vae",
            "clip",
            "controlnet",
            "upscale_models",
            "embeddings",
            "unet",
            "diffusion_models",
            "text_encoders"
          ].includes(key) && typeof val === "string") {
            const base = typeof section.base_path === "string" ? section.base_path : "";
            const full = val.match(/^[a-zA-Z]:[\\/]|^\//) ? val : path.join(base || path.dirname(file), val);
            if (includeMissing || fs.existsSync(full)) roots.push(full);
          }
        }
      }
    } catch {
    }
  }
  return [...new Set(roots.map((r) => r.replace(/\\/g, "/")))];
}
function readFileSyncSafe(file) {
  return fs.readFileSync(file, "utf-8");
}
function readSafetensorsMeta(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const headerLenBuf = Buffer.alloc(8);
    fs.readSync(fd, headerLenBuf, 0, 8, 0);
    const headerLen = Number(headerLenBuf.readBigUInt64LE(0));
    if (headerLen <= 0 || headerLen > 100 * 1024 * 1024) {
      fs.closeSync(fd);
      return null;
    }
    const jsonBuf = Buffer.alloc(Math.min(headerLen, 8 * 1024 * 1024));
    fs.readSync(fd, jsonBuf, 0, jsonBuf.length, 8);
    fs.closeSync(fd);
    const json = JSON.parse(jsonBuf.toString("utf-8").replace(/\0+$/, ""));
    const meta = json.__metadata__ || {};
    return { tensors: Object.keys(json).filter((k) => k !== "__metadata__").length, ...meta };
  } catch {
    return null;
  }
}
async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
class ModelService extends events.EventEmitter {
  downloads = /* @__PURE__ */ new Map();
  abortControllers = /* @__PURE__ */ new Map();
  list() {
    return listModels();
  }
  storageStats() {
    const map = /* @__PURE__ */ new Map();
    let total = { category: "total", count: 0, bytes: 0 };
    for (const m of listModels()) {
      const s = map.get(m.category) || { category: m.category, count: 0, bytes: 0 };
      s.count += 1;
      s.bytes += m.size;
      map.set(m.category, s);
      total.count += 1;
      total.bytes += m.size;
    }
    return [...map.values(), total];
  }
  walk(dir, out, depth = 0) {
    if (depth > 10 || out.length > 5e4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) this.walk(full, out, depth + 1);
        else if (MODEL_EXT.has(path.extname(name).toLowerCase())) out.push(full);
      } catch {
      }
    }
  }
  async scan(opts) {
    const settings = loadSettings();
    const extraRoots = parseExtraModelPaths(void 0, false).filter((p) => fs.existsSync(p));
    const scanRoots = (opts?.roots?.length ? opts.roots : [...settings.modelScanRoots, ...extraRoots]).filter(Boolean);
    const instanceModels = settings.defaultInstancePath ? [path.join(settings.defaultInstancePath, "models")] : [];
    const allRoots = [.../* @__PURE__ */ new Set([...scanRoots, ...instanceModels])];
    const files = [];
    for (const root of allRoots) {
      if (!fs.existsSync(root)) continue;
      const bucket = [];
      this.walk(root, bucket);
      files.push(...bucket);
    }
    let scanned = 0;
    for (const file of files) {
      scanned += 1;
      this.emit("progress", {
        scanned,
        total: files.length,
        currentPath: file,
        phase: "walk"
      });
      try {
        const st = fs.statSync(file);
        const id = crypto.createHash("sha1").update(file).digest("hex").slice(0, 16);
        const category = categorize(file);
        const existing = findModelByPath(file);
        let hash = existing?.hashSha256;
        if (opts?.hash && !hash) {
          this.emit("progress", {
            scanned,
            total: files.length,
            currentPath: file,
            phase: "hash"
          });
          hash = await sha256File(file);
        }
        let metadata = existing?.metadata || {};
        let architecture = existing?.architecture;
        let baseModel = existing?.baseModel;
        let trainedWords = existing?.trainedWords || [];
        if (path.extname(file).toLowerCase() === ".safetensors") {
          this.emit("progress", {
            scanned,
            total: files.length,
            currentPath: file,
            phase: "meta"
          });
          const meta = readSafetensorsMeta(file);
          if (meta) {
            metadata = { ...metadata, ...meta };
            const ss = meta.ss_base_model || meta.modelspec?.architecture;
            if (typeof ss === "string") {
              baseModel = ss;
              architecture = architecture || inferArchitecture(ss);
            }
            if (typeof meta.ss_tag_frequency === "string") {
              try {
                trainedWords = Object.keys(JSON.parse(meta.ss_tag_frequency)).slice(0, 20);
              } catch {
              }
            }
          }
        }
        architecture = architecture || inferArchitecture(path.basename(file));
        const rec = {
          id: existing?.id || id,
          name: path.parse(file).name,
          fileName: path.basename(file),
          category,
          path: file,
          size: st.size,
          hashSha256: hash,
          modifiedAt: st.mtimeMs,
          architecture,
          source: existing?.source || detectSourceFromPath(file),
          thumbnail: existing?.thumbnail,
          tags: existing?.tags || [],
          metadata,
          baseModel,
          trainedWords,
          duplicateOf: existing?.duplicateOf,
          pathRoot: allRoots.find((r) => file.startsWith(r)) || path.dirname(file)
        };
        upsertModel(rec);
      } catch {
      }
    }
    if (opts?.hash !== false) {
      this.markDuplicates();
    }
    this.emit("progress", {
      scanned: files.length,
      total: files.length,
      currentPath: "",
      phase: "done"
    });
    return this.list();
  }
  markDuplicates() {
    const byHash = /* @__PURE__ */ new Map();
    for (const m of listModels()) {
      if (!m.hashSha256) continue;
      const arr = byHash.get(m.hashSha256) || [];
      arr.push(m);
      byHash.set(m.hashSha256, arr);
    }
    for (const arr of byHash.values()) {
      if (arr.length < 2) {
        for (const m of arr) {
          if (m.duplicateOf) updateModel(m.id, { duplicateOf: "" });
        }
        continue;
      }
      const primary = arr[0];
      for (let i = 1; i < arr.length; i++) {
        updateModel(arr[i].id, { duplicateOf: primary.path });
      }
    }
  }
  findDuplicates() {
    const byHash = /* @__PURE__ */ new Map();
    for (const m of listModels()) {
      if (!m.hashSha256) continue;
      const entry = byHash.get(m.hashSha256) || { files: [], size: m.size };
      entry.files.push(m.path);
      entry.size = m.size;
      byHash.set(m.hashSha256, entry);
    }
    return [...byHash.entries()].filter(([, v]) => v.files.length > 1).map(([hash, v]) => ({ hash, size: v.size, files: v.files }));
  }
  async remove(id, deleteFile) {
    const models = listModels();
    const rec = models.find((m) => m.id === id);
    if (!rec) return false;
    if (deleteFile && fs.existsSync(rec.path)) fs.unlinkSync(rec.path);
    return deleteModel(id);
  }
  async move(id, destDir) {
    const rec = listModels().find((m) => m.id === id);
    if (!rec) throw new Error("Model not found");
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, rec.fileName);
    if (fs.existsSync(destPath) && destPath !== rec.path) {
      throw new Error(`Target already exists: ${destPath}`);
    }
    if (destPath === rec.path) return rec;
    try {
      fs.renameSync(rec.path, destPath);
    } catch (err) {
      const code = err.code;
      if (code === "EXDEV") {
        const { copyFileSync, unlinkSync: ul } = await import("fs");
        copyFileSync(rec.path, destPath);
        ul(rec.path);
      } else {
        throw err;
      }
    }
    deleteModel(id);
    const next = {
      ...rec,
      id: crypto.createHash("sha1").update(destPath).digest("hex").slice(0, 16),
      path: destPath,
      pathRoot: destDir
    };
    upsertModel(next);
    return next;
  }
  async symlink(id, destDir) {
    const rec = listModels().find((m) => m.id === id);
    if (!rec) throw new Error("Model not found");
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, rec.fileName);
    if (fs.existsSync(destPath)) throw new Error(`Target already exists: ${destPath}`);
    fs.symlinkSync(rec.path, destPath, "file");
    const next = {
      ...rec,
      id: crypto.createHash("sha1").update(destPath).digest("hex").slice(0, 16),
      path: destPath,
      pathRoot: destDir,
      source: "imported"
    };
    upsertModel(next);
    return next;
  }
  async rename(id, newName) {
    const rec = listModels().find((m) => m.id === id);
    if (!rec) throw new Error("Model not found");
    updateModel(id, { name: newName });
    return { ...rec, name: newName };
  }
  async tag(id, tags) {
    const rec = listModels().find((m) => m.id === id);
    if (!rec) throw new Error("Model not found");
    updateModel(id, { tags });
    return { ...rec, tags };
  }
  listDownloads() {
    return this.downloads.size ? [...this.downloads.values()] : listDownloadTasks();
  }
  detectDownloadSource(url) {
    if (url.includes("civitai.com")) return "civitai";
    if (url.includes("huggingface.co") || url.includes("hf.co")) return "huggingface";
    return "direct";
  }
  async download(opts) {
    const { isSafeExternalUrl: isSafeExternalUrl2 } = await Promise.resolve().then(() => security);
    if (!isSafeExternalUrl2(opts.url)) {
      throw new Error(`Blocked download URL scheme: ${opts.url.slice(0, 40)}`);
    }
    const settings = loadSettings();
    const defaultDir = settings.downloadDir || path.join(os.homedir(), "Downloads", "ComfyPilot");
    let destDir = opts.destDir || defaultDir;
    {
      const { resolveInsideAnyRoot: resolveInsideAnyRoot2 } = await Promise.resolve().then(() => security);
      const allowedRoots = [
        settings.downloadDir,
        path.join(os.homedir(), "Downloads"),
        ...settings.modelScanRoots,
        settings.defaultInstancePath && path.join(settings.defaultInstancePath, "models")
      ].filter(Boolean);
      const safeDest = resolveInsideAnyRoot2(destDir, allowedRoots);
      if (!safeDest) destDir = defaultDir;
      else destDir = safeDest;
    }
    fs.mkdirSync(destDir, { recursive: true });
    let url = opts.url;
    if (url.includes("civitai.com") && !url.includes("/api/download")) {
      const idMatch = url.match(/models\/(\d+)/);
      const verMatch = url.match(/modelVersionId=(\d+)/);
      if (idMatch) {
        const ver = verMatch?.[1];
        url = `https://civitai.com/api/download/models/${ver || idMatch[1]}`;
      }
    }
    const rawName = opts.fileName || path.basename(new URL(url).pathname) || `download-${Date.now()}`;
    const { assertSafeRelativeFilename: assertSafeRelativeFilename2 } = await Promise.resolve().then(() => security);
    const fileName = assertSafeRelativeFilename2(rawName);
    const destPath = path.join(destDir, fileName);
    const id = crypto.createHash("sha1").update(url + destPath).digest("hex").slice(0, 12);
    const task = {
      id,
      url,
      destPath,
      fileName,
      totalBytes: 0,
      receivedBytes: 0,
      status: "queued",
      startedAt: Date.now(),
      source: this.detectDownloadSource(url)
    };
    this.downloads.set(id, task);
    upsertDownloadTask(task);
    this.emit("download", { ...task });
    void this.runDownload(task);
    return task;
  }
  async runDownload(task, resume = false) {
    if (this.abortControllers.has(task.id)) {
      throw new Error("Download already in progress");
    }
    const settings = loadSettings();
    if (settings.useAria2 && (settings.aria2Path || "aria2c")) {
      try {
        const { aria2Service } = await Promise.resolve().then(() => require("./chunks/media-B-raWoxp.js"));
        if (aria2Service.available()) {
          task.status = "running";
          this.emit("download", { ...task });
          const res = await aria2Service.download(task.url, task.destPath, { resume });
          task.status = res.ok ? "done" : "error";
          task.error = res.ok ? void 0 : res.log.slice(0, 300);
          task.finishedAt = Date.now();
          if (res.ok && fs.existsSync(task.destPath)) {
            task.receivedBytes = fs.statSync(task.destPath).size;
            task.totalBytes = task.receivedBytes;
            if (resume) task.resumedFrom = Math.max(0, task.receivedBytes);
          }
          upsertDownloadTask(task);
          this.emit("download", { ...task });
          return;
        }
      } catch {
      }
    }
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);
    try {
      task.status = "running";
      this.emit("download", { ...task });
      const { shouldBypass: shouldBypass2, buildBypassList: buildBypassList2 } = await Promise.resolve().then(() => proxy);
      const { session } = await import("electron");
      const psettings = loadSettings().proxy;
      const useSessionProxy = psettings.enabled && !shouldBypass2(task.url, buildBypassList2(psettings));
      const headers = {};
      let startByte = 0;
      if (resume && fs.existsSync(task.destPath)) {
        startByte = fs.statSync(task.destPath).size;
        if (startByte > 0) headers.Range = `bytes=${startByte}-`;
      }
      const res = useSessionProxy ? await session.defaultSession.fetch(task.url, {
        method: "GET",
        headers,
        signal: controller.signal
      }) : await fetch(task.url, { headers, signal: controller.signal });
      if (resume && res.status === 416 && fs.existsSync(task.destPath)) {
        task.status = "done";
        task.receivedBytes = fs.statSync(task.destPath).size;
        task.totalBytes = task.receivedBytes;
        task.finishedAt = Date.now();
        upsertDownloadTask(task);
        this.emit("download", { ...task });
        return;
      }
      const isPartial = res.status === 206;
      if (!res.ok && !isPartial) throw new Error(`HTTP ${res.status}`);
      const appendMode = resume && startByte > 0 && isPartial;
      if (resume && startByte > 0 && !isPartial) {
        startByte = 0;
      }
      const contentLength = Number(res.headers.get("content-length") || 0);
      task.totalBytes = isPartial ? startByte + contentLength : contentLength || task.totalBytes;
      task.receivedBytes = appendMode ? startByte : 0;
      task.resumedFrom = appendMode ? startByte : void 0;
      const mode = appendMode ? "a" : "w";
      const file = fs.createWriteStream(task.destPath, { flags: mode });
      let streamClosed = false;
      const closeStream = () => new Promise((resolve) => {
        if (streamClosed) return resolve();
        streamClosed = true;
        try {
          file.end(() => resolve());
        } catch {
          try {
            file.destroy();
          } catch {
          }
          resolve();
        }
      });
      const reader = res.body?.getReader();
      if (!reader) {
        await closeStream();
        throw new Error("No response body");
      }
      let lastTick = Date.now();
      let windowBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          file.write(Buffer.from(value));
          task.receivedBytes += value.byteLength;
          windowBytes += value.byteLength;
          const now = Date.now();
          if (now - lastTick > 500) {
            task.speedBps = windowBytes / (now - lastTick) * 1e3;
            windowBytes = 0;
            lastTick = now;
            upsertDownloadTask(task);
            this.emit("download", { ...task });
          }
        }
      } finally {
        try {
          reader.cancel().catch(() => void 0);
        } catch {
        }
        await closeStream();
      }
      task.status = "done";
      task.finishedAt = Date.now();
      task.speedBps = 0;
      upsertDownloadTask(task);
    } catch (err) {
      const current = this.downloads.get(task.id)?.status ?? task.status;
      if (current !== "cancelled") {
        if (controller.signal.aborted) {
          task.status = "paused";
        } else {
          task.status = "error";
          task.error = err instanceof Error ? err.message : String(err);
        }
        task.finishedAt = Date.now();
        upsertDownloadTask(task);
      }
    } finally {
      this.abortControllers.delete(task.id);
    }
    this.emit("download", { ...task });
  }
  pauseDownload(id) {
    const task = this.downloads.get(id) || listDownloadTasks().find((t) => t.id === id);
    if (!task) throw new Error("Download not found");
    this.abortControllers.get(id)?.abort();
    task.status = "paused";
    this.downloads.set(id, task);
    upsertDownloadTask(task);
    this.emit("download", { ...task });
    return task;
  }
  async resumeDownload(id) {
    const task = this.downloads.get(id) || listDownloadTasks().find((t) => t.id === id);
    if (!task) throw new Error("Download not found");
    if (this.abortControllers.has(id)) {
      throw new Error("Download already in progress");
    }
    task.status = "queued";
    this.downloads.set(id, task);
    this.emit("download", { ...task });
    await this.runDownload(task, true);
    return task;
  }
  cancelDownload(id) {
    const task = this.downloads.get(id);
    if (task) {
      task.status = "cancelled";
      task.error = "cancelled";
    }
    this.abortControllers.get(id)?.abort();
    if (task) {
      upsertDownloadTask(task);
      this.emit("download", { ...task });
    }
    this.downloads.delete(id);
    this.abortControllers.delete(id);
    return true;
  }
  async fetchCivitaiMeta(modelIdOrUrl) {
    try {
      const settings = loadSettings();
      const base = settings.civitaiEndpoint || "https://civitai.com";
      let id = modelIdOrUrl;
      const m = modelIdOrUrl.match(/models\/(\d+)/);
      if (m) id = m[1];
      const res = await fetch(`${base}/api/v1/models/${id}`, {
        signal: AbortSignal.timeout(8e3)
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
  /** Storage analysis: bytes per top-level folder under model roots. */
  storageAnalysis() {
    return this.storageStats();
  }
}
const modelService = new ModelService();
const model = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  ModelService,
  modelService,
  parseExtraModelPaths,
  readSafetensorsMeta,
  sha256File
}, Symbol.toStringTag, { value: "Module" }));
function buildProxyUrl(p, opts) {
  if (!p.enabled || !p.host || !p.port) return "";
  const withAuth = opts?.withAuth !== false;
  const auth = withAuth && p.username ? `${encodeURIComponent(p.username)}${p.password ? ":" + encodeURIComponent(p.password) : ""}@` : "";
  const proto = p.protocol === "socks5" ? "socks5" : p.protocol === "https" ? "https" : "http";
  return `${proto}://${auth}${p.host}:${p.port}`;
}
function redactProxyUrl(p) {
  return buildProxyUrl(p, { withAuth: false });
}
function buildBypassList(p) {
  const extra = String(p.bypass || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  return [.../* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1", ...extra])].join(";");
}
function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
}
function shouldBypass(url, bypassList) {
  try {
    const u = new URL(url);
    const host = normalizeHost(u.hostname);
    const list = bypassList.split(/[;\s,]+/).map((s) => normalizeHost(s.trim().replace(/^\./, ""))).filter(Boolean);
    return list.some((b) => {
      if (host === b) return true;
      if (!b.includes(".")) return false;
      return host.endsWith("." + b);
    });
  } catch {
    return false;
  }
}
function proxyEnv(p) {
  const base = { ...process.env };
  delete base.HTTP_PROXY;
  delete base.HTTPS_PROXY;
  delete base.ALL_PROXY;
  delete base.http_proxy;
  delete base.https_proxy;
  delete base.all_proxy;
  delete base.NO_PROXY;
  delete base.no_proxy;
  if (!p.enabled) return base;
  const url = buildProxyUrl(p);
  if (!url) return base;
  base.HTTP_PROXY = url;
  base.HTTPS_PROXY = url;
  base.http_proxy = url;
  base.https_proxy = url;
  if (p.protocol === "socks5") {
    base.ALL_PROXY = url;
    base.all_proxy = url;
  }
  const bypass = buildBypassList(p).replace(/;/g, ",");
  base.NO_PROXY = bypass;
  base.no_proxy = bypass;
  return base;
}
function assertSafeProxyHost(host) {
  const h = String(host || "").trim();
  if (!h) throw new Error("Proxy host is empty");
  if (/[;@\s\\/]/.test(h)) throw new Error("Proxy host contains illegal characters");
  return h;
}
function assertSafeProxyPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Invalid proxy port");
  return n;
}
function applyProxyToElectron(p) {
  const bypass = buildBypassList(p);
  const ses = electron.session.defaultSession;
  if (!p.enabled || !p.host || !p.port) {
    void ses.setProxy({ mode: "direct" });
    return { enabled: false, url: "", bypass };
  }
  assertSafeProxyHost(p.host);
  assertSafeProxyPort(p.port);
  const rules = `${p.protocol === "socks5" ? "socks" : p.protocol}://${p.host}:${p.port}`;
  void ses.setProxy({
    mode: "fixed_servers",
    proxyRules: rules,
    proxyBypassRules: bypass
  });
  return { enabled: true, url: redactProxyUrl(p), bypass };
}
async function fetchThroughProxy(url, opts) {
  if (!isSafeExternalUrl(url)) throw new Error("Blocked unsafe URL for proxy test");
  return electron.session.defaultSession.fetch(url, {
    method: opts?.method || "GET",
    signal: AbortSignal.timeout(1e4)
  });
}
async function testProxy(opts) {
  const settings = loadSettings();
  const p = settings.proxy;
  const target = opts?.url || "https://www.gstatic.com/generate_204";
  const started = Date.now();
  const via = p.enabled ? redactProxyUrl(p) : "direct";
  try {
    applyProxyToElectron(p);
    const res = await fetchThroughProxy(target);
    return {
      ok: res.ok || res.status === 204 || res.status === 302,
      via,
      ms: Date.now() - started
    };
  } catch (e) {
    return {
      ok: false,
      via,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}
function syncProxyFromSettings() {
  try {
    return applyProxyToElectron(loadSettings().proxy);
  } catch {
    try {
      void electron.session.defaultSession.setProxy({ mode: "direct" });
    } catch {
    }
    return { enabled: false, url: "", bypass: "" };
  }
}
const proxy = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  applyProxyToElectron,
  assertSafeProxyHost,
  assertSafeProxyPort,
  buildBypassList,
  buildProxyUrl,
  fetchThroughProxy,
  proxyEnv,
  redactProxyUrl,
  shouldBypass,
  syncProxyFromSettings,
  testProxy
}, Symbol.toStringTag, { value: "Module" }));
const execFileAsync$2 = util.promisify(child_process.execFile);
function sanitizeInstallName(name) {
  return String(name).replace(/[^\w.-]/g, "_").replace(/\.\./g, "_").slice(0, 80);
}
function resolveNestedPackDir(dest) {
  try {
    const entries = fs.readdirSync(dest).filter((n) => !n.startsWith(".") && n !== "__MACOSX");
    if (entries.length === 1) {
      const nested = path.join(dest, entries[0]);
      if (fs.statSync(nested).isDirectory()) {
        const hasMeta = fs.existsSync(path.join(nested, "__init__.py")) || fs.existsSync(path.join(nested, "pyproject.toml")) || fs.existsSync(path.join(nested, "requirements.txt"));
        if (hasMeta) return nested;
      }
    }
  } catch {
  }
  return dest;
}
function detectCustomNodesRoot(instancePath) {
  const settings = loadSettings();
  const candidates = [
    instancePath && path.join(instancePath, "custom_nodes"),
    settings.defaultInstancePath && path.join(settings.defaultInstancePath, "custom_nodes"),
    process.env.COMFYUI_PATH && path.join(process.env.COMFYUI_PATH, "custom_nodes")
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || candidates[0] || "";
}
function readPackMeta(dir) {
  const pyproject = path.join(dir, "pyproject.toml");
  const pkgJson = path.join(dir, "package.json");
  let name = dir.split(/[\\/]/).pop() || "unknown";
  let version = "0.0.0";
  let description = "";
  let repository;
  let license;
  let pythonCompatible;
  if (fs.existsSync(pyproject)) {
    const text = fs.readFileSync(pyproject, "utf-8");
    const n = text.match(/name\s*=\s*["']([^"']+)["']/);
    const v = text.match(/version\s*=\s*["']([^"']+)["']/);
    const d = text.match(/description\s*=\s*["']([^"']+)["']/);
    const r = text.match(/(?:repository|homepage)\s*=\s*["']([^"']+)["']/);
    const l = text.match(/license\s*=\s*["']([^"']+)["']/);
    const py = text.match(/requires-python\s*=\s*["']([^"']+)["']/);
    if (n) name = n[1];
    if (v) version = v[1];
    if (d) description = d[1];
    if (r) repository = r[1];
    if (l) license = l[1];
    if (py) pythonCompatible = py[1];
  } else if (fs.existsSync(pkgJson)) {
    try {
      const json = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
      name = json.name || name;
      version = json.version || version;
      description = json.description || "";
      repository = json.repository?.url || json.homepage;
      license = json.license;
    } catch {
    }
  }
  let nodeList = [];
  const nodeListFile = path.join(dir, "node_list.json");
  if (fs.existsSync(nodeListFile)) {
    try {
      const json = JSON.parse(fs.readFileSync(nodeListFile, "utf-8"));
      if (Array.isArray(json)) nodeList = json.map(String);
      else if (json.nodes) nodeList = Object.keys(json.nodes);
    } catch {
    }
  } else {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".py")) continue;
      try {
        const text = fs.readFileSync(path.join(dir, f), "utf-8");
        const block = text.match(/NODE_CLASS_MAPPINGS\s*[:=][\s\S]{0,2000}/);
        if (block) {
          const re = /["']([A-Za-z0-9_]{3,})["']\s*:/g;
          let m;
          while (m = re.exec(block[0])) nodeList.push(m[1]);
        }
      } catch {
      }
    }
    nodeList = [...new Set(nodeList)].slice(0, 200);
  }
  return {
    name,
    displayName: name,
    version,
    description,
    repository,
    license,
    pythonCompatible,
    nodeList
  };
}
function collectIssues(dir, meta) {
  const issues = [];
  const req = path.join(dir, "requirements.txt");
  const pyproject = path.join(dir, "pyproject.toml");
  const hasInit = fs.existsSync(path.join(dir, "__init__.py"));
  if (!hasInit && !fs.existsSync(pyproject)) {
    issues.push({
      severity: "warning",
      code: "NO_ENTRY",
      message: "Missing __init__.py or pyproject.toml — package may not load.",
      suggestion: "Confirm the pack is a valid custom node package.",
      fixable: false
    });
  }
  if (fs.existsSync(req)) {
    const text = fs.readFileSync(req, "utf-8");
    if (/torch\s*==/i.test(text)) {
      issues.push({
        severity: "warning",
        code: "TORCH_PIN",
        message: "requirements.txt pins torch — may conflict with instance CUDA build.",
        suggestion: "Prefer torch>= without exact pin, or manage via dedicated venv.",
        fixable: true,
        fixId: "unpin-torch"
      });
    }
    if (/opencv-python\s*==/i.test(text)) {
      issues.push({
        severity: "info",
        code: "CV_PIN",
        message: "opencv-python is pinned; GUI builds sometimes conflict on headless hosts.",
        fixable: false
      });
    }
  }
  if (!meta.repository) {
    issues.push({
      severity: "info",
      code: "NO_REPO",
      message: "No repository metadata found.",
      suggestion: "Add repository field in pyproject.toml for update checks.",
      fixable: false
    });
  }
  return issues;
}
class NodePackService {
  list(instancePath) {
    const root = detectCustomNodesRoot(instancePath);
    if (!root || !fs.existsSync(root)) return [];
    const known = new Map(listNodePacks().map((p) => [p.name, p]));
    const packs = [];
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(".") || name.endsWith(".trash") || name.includes(".trash-") || name.includes(".bak-"))
        continue;
      const dir = path.join(root, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const meta = readPackMeta(dir);
      const issues = collectIssues(dir, meta);
      const disabledMarker = path.join(dir, ".disabled");
      const disabled = fs.existsSync(disabledMarker) || name.endsWith(".disabled");
      const id = crypto.createHash("sha1").update(dir).digest("hex").slice(0, 16);
      const prev = known.get(meta.name || name);
      packs.push({
        id,
        name: meta.name || name,
        displayName: meta.displayName || name,
        description: meta.description || "",
        author: prev?.author || "",
        version: meta.version || "0.0.0",
        latestVersion: prev?.latestVersion,
        status: disabled ? "disabled" : issues.some((i) => i.severity === "error") ? "error" : "installed",
        path: dir,
        repository: meta.repository,
        nodeCount: meta.nodeList?.length || 0,
        tags: prev?.tags || [],
        installSource: prev?.installSource || "local",
        lastCheckedAt: Date.now(),
        issues,
        locked: prev?.locked || false,
        nodeList: meta.nodeList || [],
        license: meta.license,
        pythonCompatible: meta.pythonCompatible
      });
    }
    return packs;
  }
  async refresh() {
    const packs = this.list();
    const known = new Map(listNodePacks().map((p) => [p.id, p]));
    for (const p of packs) {
      const prev = known.get(p.id);
      if (prev?.locked) p.locked = true;
      upsertNodePack(p);
    }
    return packs;
  }
  /** Manager channel list (PLAN: Registry + Manager channel + 本地) */
  async managerChannelList() {
    const settings = loadSettings();
    const endpoints = [
      "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/custom-node-list.json",
      "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/manager-v4/custom-node-list.json"
    ];
    const out = [];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8e3),
          headers: { "User-Agent": "ComfyPilot/0.1" }
        });
        if (!res.ok) continue;
        const data = await res.json();
        for (const n of data.slice(0, 200)) {
          out.push({
            id: String(n.id || n.title || n.name),
            name: String(n.name || n.title || ""),
            displayName: String(n.title || n.name || ""),
            description: String(n.description || ""),
            author: String(n.author || ""),
            latestVersion: String(n.version || ""),
            repository: String(n.repository || ""),
            tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
            downloads: Number(n.downloads || 0),
            score: 0,
            status: "active"
          });
        }
        if (out.length) break;
      } catch {
        if (settings.networkMode === "offline") break;
      }
    }
    return out;
  }
  async registrySearch(opts) {
    const settings = loadSettings();
    const q = encodeURIComponent(opts?.query || "");
    const url = `${REGISTRY_API}/nodes?limit=${opts?.limit || 30}&offset=0${q ? `&search=${q}` : ""}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "ComfyPilot/0.1" },
        signal: AbortSignal.timeout(1e4)
      });
      if (!res.ok) throw new Error(`Registry HTTP ${res.status}`);
      const data = await res.json();
      const items = data.nodes || data.items || [];
      return items.map((n) => ({
        id: String(n.id || n.name),
        name: String(n.name || ""),
        displayName: String(n.displayName || n.title || n.name),
        description: String(n.description || ""),
        author: String(n.publisher?.name || n.author || ""),
        latestVersion: String(n.latest_version || n.version || ""),
        repository: String(n.repository || n.html_url || ""),
        tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
        downloads: Number(n.downloads || n.downloadsTotal || 0),
        score: Number(n.score || 0),
        icon: n.icon ? String(n.icon) : void 0,
        status: n.status || "active"
      }));
    } catch (err) {
      if (settings.networkMode === "offline") return [];
      throw err;
    }
  }
  assertInstallAllowed(source) {
    const settings = loadSettings();
    if (settings.networkMode === "offline") {
      throw new Error("Offline mode forbids remote installs");
    }
    if (source === "git") {
      if (!settings.allowGitUrlInstall) {
        throw new Error("Git URL install is disabled (allow_git_url_install=false)");
      }
      if (settings.securityLevel === "strong") {
        throw new Error("security_level=strong forbids git installs");
      }
    }
    if (source === "registry" || source === "manager") {
      if (settings.securityLevel === "strong") {
        throw new Error("security_level=strong forbids remote node installs");
      }
    }
  }
  async install(opts) {
    this.assertInstallAllowed(opts.source);
    try {
      this.createSnapshot(`auto-pre-install-${sanitizeInstallName(opts.id)}`);
    } catch {
    }
    const root = detectCustomNodesRoot();
    if (!root) throw new Error("custom_nodes root not found — add a ComfyUI instance first");
    fs.mkdirSync(root, { recursive: true });
    if (opts.source === "git") {
      const { assertSafeGitUrl: assertSafeGitUrl2 } = await Promise.resolve().then(() => installer);
      const url = assertSafeGitUrl2(opts.url || opts.id);
      const destName = sanitizeInstallName(url.split("/").pop()?.replace(/\.git$/, "") || `pack-${Date.now()}`);
      const dest2 = path.join(root, destName);
      await execFileAsync$2("git", ["clone", "--depth", "1", url, dest2], {
        timeout: 12e4,
        maxBuffer: 20 * 1024 * 1024,
        env: proxyEnv(loadSettings().proxy)
      });
      return this.afterInstall(resolveNestedPackDir(dest2));
    }
    const versionPart = opts.version ? `/${opts.version}` : "";
    const apiUrl = `${REGISTRY_API}/nodes/${encodeURIComponent(opts.id)}/install${versionPart}`;
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "ComfyPilot/0.1" },
      signal: AbortSignal.timeout(15e3)
    });
    if (!res.ok) throw new Error(`Registry install failed: HTTP ${res.status}`);
    const data = await res.json();
    const downloadUrl = data.url || data.downloadUrl;
    if (data.status === "banned") throw new Error("Node pack is banned on Registry");
    if (!downloadUrl) throw new Error("Registry did not return a download URL");
    const { isSafeExternalUrl: isSafeExternalUrl2 } = await Promise.resolve().then(() => security);
    if (!isSafeExternalUrl2(downloadUrl)) {
      throw new Error("Blocked registry download URL scheme");
    }
    const zipRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(18e4) });
    if (!zipRes.ok) throw new Error(`Download failed: HTTP ${zipRes.status}`);
    const buf = Buffer.from(await zipRes.arrayBuffer());
    const tmpZip = path.join(root, `._install_${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, buf);
    const dest = path.join(root, sanitizeInstallName(opts.id));
    try {
      const { safeUnzip } = await Promise.resolve().then(() => require("./chunks/zipSafe-BhCMgjq_.js"));
      await safeUnzip(tmpZip, dest);
    } catch (e) {
      try {
        fs.unlinkSync(tmpZip);
      } catch {
      }
      if (fs.existsSync(dest)) {
        try {
          fs.rmSync(dest, { recursive: true, force: true });
        } catch {
        }
      }
      throw e;
    }
    try {
      fs.unlinkSync(tmpZip);
    } catch {
    }
    return this.afterInstall(resolveNestedPackDir(dest));
  }
  afterInstall(dir) {
    const meta = readPackMeta(dir);
    const issues = collectIssues(dir, meta);
    const rec = {
      id: crypto.createHash("sha1").update(dir).digest("hex").slice(0, 16),
      name: meta.name || dir.split(/[\\/]/).pop() || "unknown",
      displayName: meta.displayName || "unknown",
      description: meta.description || "",
      author: "",
      version: meta.version || "0.0.0",
      status: "installed",
      path: dir,
      repository: meta.repository,
      nodeCount: meta.nodeList?.length || 0,
      tags: [],
      installSource: "registry",
      lastCheckedAt: Date.now(),
      issues,
      locked: false,
      nodeList: meta.nodeList || [],
      license: meta.license,
      pythonCompatible: meta.pythonCompatible
    };
    upsertNodePack(rec);
    return rec;
  }
  async uninstall(idOrName) {
    const packs = this.list();
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName);
    if (!pack?.path) return false;
    if (pack.locked) throw new Error("Pack is locked — unlock before uninstall");
    const trash = `${pack.path}.trash-${Date.now()}`;
    try {
      fs.renameSync(pack.path, trash);
      fs.rmSync(trash, { recursive: true, force: true });
    } catch {
      fs.rmSync(pack.path, { recursive: true, force: true });
    }
    deleteNodePack(pack.id);
    return true;
  }
  async update(idOrName, version) {
    const packs = this.list();
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName);
    if (!pack) throw new Error("Pack not found");
    if (pack.locked) throw new Error("Pack is locked");
    if (pack.registryId || pack.installSource === "registry") {
      if (pack.path) {
        const trash = `${pack.path}.bak-${Date.now()}`;
        fs.renameSync(pack.path, trash);
        try {
          const next = await this.install({
            id: pack.registryId || pack.name,
            version,
            source: "registry"
          });
          try {
            fs.rmSync(trash, { recursive: true, force: true });
          } catch {
          }
          deleteNodePack(pack.id);
          return next;
        } catch (e) {
          try {
            if (fs.existsSync(pack.path)) fs.rmSync(pack.path, { recursive: true, force: true });
            fs.renameSync(trash, pack.path);
          } catch {
          }
          throw e;
        }
      }
    }
    if (pack.path && fs.existsSync(path.join(pack.path, ".git"))) {
      await execFileAsync$2("git", ["-C", pack.path, "pull", "--ff-only"], {
        timeout: 6e4,
        maxBuffer: 20 * 1024 * 1024,
        env: proxyEnv(loadSettings().proxy)
      });
      return this.afterInstall(pack.path);
    }
    throw new Error("Pack is not updatable via Registry or git");
  }
  toggle(idOrName, enabled) {
    const packs = this.list();
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName);
    if (!pack?.path) return void 0;
    let dir = pack.path;
    if (!enabled) {
      const disabledMarker = path.join(dir, ".disabled");
      fs.writeFileSync(disabledMarker, String(Date.now()));
      pack.status = "disabled";
    } else {
      const disabledMarker = path.join(dir, ".disabled");
      if (fs.existsSync(disabledMarker)) fs.unlinkSync(disabledMarker);
      if (dir.endsWith(".disabled")) {
        const target = dir.slice(0, -".disabled".length);
        if (!fs.existsSync(target)) {
          fs.renameSync(dir, target);
          dir = target;
          pack.path = target;
        }
      }
      pack.status = "installed";
    }
    upsertNodePack(pack);
    return pack;
  }
  lock(idOrName, locked) {
    const packs = this.list();
    const pack = packs.find((p) => p.id === idOrName || p.name === idOrName);
    if (!pack) return void 0;
    pack.locked = locked;
    upsertNodePack(pack);
    return pack;
  }
  checkIssues(idOrName) {
    return this.list().find((p) => p.id === idOrName || p.name === idOrName)?.issues || [];
  }
  conflicts() {
    const map = /* @__PURE__ */ new Map();
    for (const pack of this.list()) {
      for (const node of pack.nodeList || []) {
        const arr = map.get(node) || [];
        arr.push(pack.name);
        map.set(node, arr);
      }
    }
    return [...map.entries()].filter(([, packs]) => packs.length > 1).map(([nodeName, packs]) => ({ nodeName, packs: [...new Set(packs)] }));
  }
  async smokeTest(idOrName) {
    const pack = this.list().find((p) => p.id === idOrName || p.name === idOrName);
    if (!pack?.path) return [];
    const issues = [];
    const settings = loadSettings();
    const configs = loadInstanceConfigs();
    const inst = configs[0];
    let python = settings.defaultInstancePath ? "python" : "python";
    if (inst?.venvPath) {
      const win = path.join(inst.venvPath, "Scripts", "python.exe");
      const unix = path.join(inst.venvPath, "bin", "python");
      if (fs.existsSync(win)) python = win;
      else if (fs.existsSync(unix)) python = unix;
    } else if (inst?.pythonPath) {
      python = inst.pythonPath;
    }
    try {
      await execFileAsync$2(
        python,
        [
          "-c",
          'import importlib.util,sys,os;p=sys.argv[1];f=os.path.join(p,"__init__.py");spec=importlib.util.spec_from_file_location("cp_pack",f) if os.path.isfile(f) else None;sys.exit(0 if spec else 2)',
          pack.path
        ],
        { timeout: 15e3, cwd: pack.path, maxBuffer: 20 * 1024 * 1024 }
      );
    } catch (e) {
      issues.push({
        severity: "error",
        code: "IMPORT_FAIL",
        message: `Import smoke test failed: ${e instanceof Error ? e.message.slice(0, 220) : String(e)}`,
        suggestion: "Check requirements and Python version compatibility.",
        fixable: false
      });
    }
    return issues;
  }
  snapshots() {
    return listSnapshots();
  }
  createSnapshot(name) {
    const packs = this.list().map((p) => ({
      name: p.name,
      version: p.version,
      path: p.path || "",
      source: p.status === "disabled" ? `${p.installSource}@disabled` : p.installSource
    }));
    const snapshot = {
      id: crypto.randomUUID(),
      name: name || `snapshot-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
      createdAt: Date.now(),
      packs,
      notes: ""
    };
    insertSnapshot(snapshot);
    try {
      fs.writeFileSync(path.join(snapshotDir(), `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2));
    } catch {
    }
    return snapshot;
  }
  restoreSnapshot(id) {
    const snap = getSnapshot(id);
    if (!snap) return false;
    const current = this.list();
    const currentNames = new Set(current.map((p) => p.name));
    const snapNames = new Set(snap.packs.map((p) => p.name));
    const snapDisabled = new Set(
      snap.packs.filter((p) => p.source.endsWith("@disabled")).map((p) => p.name)
    );
    const snapEnabled = new Set(
      snap.packs.filter((p) => !p.source.endsWith("@disabled")).map((p) => p.name)
    );
    for (const p of current) {
      if (!snapNames.has(p.name)) {
        this.toggle(p.name, false);
      } else if (snapDisabled.has(p.name)) {
        this.toggle(p.name, false);
      } else if (snapEnabled.has(p.name)) {
        this.toggle(p.name, true);
      }
    }
    for (const s of snap.packs) {
      if (!currentNames.has(s.name) && s.path && fs.existsSync(s.path)) {
        try {
          const marker = path.join(s.path, ".disabled");
          if (snapDisabled.has(s.name) && !fs.existsSync(marker)) fs.writeFileSync(marker, String(Date.now()));
          if (snapEnabled.has(s.name) && fs.existsSync(marker)) fs.unlinkSync(marker);
        } catch {
        }
      }
    }
    return true;
  }
  deleteSnapshot(id) {
    const { sanitizeId: sanitizeId2, isPathInside: isPathInside2 } = require("./security");
    const safe = sanitizeId2(id);
    try {
      const file = path.join(snapshotDir(), `${safe}.json`);
      if (fs.existsSync(file) && isPathInside2(file, snapshotDir())) fs.unlinkSync(file);
    } catch {
    }
    return deleteSnapshot(safe);
  }
}
const nodePackService = new NodePackService();
const COMFY_CLIENT_ID = "comfy-pilot";
class ComfyApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  url(path2) {
    return `${this.baseUrl.replace(/\/$/, "")}${path2}`;
  }
  async systemStats() {
    try {
      const res = await fetch(this.url("/system_stats"), { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
  async objectInfo() {
    try {
      const res = await fetch(this.url("/object_info"), { signal: AbortSignal.timeout(5e3) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
  async queuePrompt(prompt, clientId) {
    try {
      const res = await fetch(this.url("/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
        signal: AbortSignal.timeout(8e3)
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.prompt_id || null;
    } catch {
      return null;
    }
  }
  async history(limit = 20) {
    try {
      const res = await fetch(this.url("/history?max_items=" + limit), {
        signal: AbortSignal.timeout(2e3)
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Object.entries(data).map(([promptId, v]) => ({
        promptId,
        status: String(v?.status?.completed ? "done" : "unknown"),
        completedAt: Number(v?.status?.completed_at || 0) || void 0
      }));
    } catch {
      return [];
    }
  }
  async interrupt() {
    try {
      const res = await fetch(this.url("/interrupt"), { method: "POST" });
      return res.ok;
    } catch {
      return false;
    }
  }
}
const comfyApi = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  COMFY_CLIENT_ID,
  ComfyApiClient
}, Symbol.toStringTag, { value: "Module" }));
function extractPngTextMeta(buf) {
  const meta = {};
  try {
    let offset = 8;
    while (offset + 8 < buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString("ascii", offset + 4, offset + 8);
      if (type === "tEXt" || type === "iTXt") {
        const data = buf.toString("utf-8", offset + 8, offset + 8 + len);
        const nul = data.indexOf("\0");
        if (nul > 0) {
          const key = data.slice(0, nul);
          const value = data.slice(nul + 1);
          meta[key] = value;
        }
      }
      if (type === "IEND") break;
      offset += 12 + len;
    }
  } catch {
  }
  return meta;
}
function parseWorkflowJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
class WorkflowService {
  list(dir) {
    const settings = loadSettings();
    const instances = loadInstanceConfigs();
    const roots = [
      dir,
      ...instances.map((i) => path.join(i.path, "user", "default", "workflows")),
      path.join(settings.defaultInstancePath, "user", "default", "workflows"),
      path.join(process.cwd(), "workflows")
    ].filter(Boolean);
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const root of [...new Set(roots)]) {
      if (!root || !fs.existsSync(root)) continue;
      this.walk(root, out, seen, 0);
    }
    for (const w of out) upsertWorkflow(w);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  walk(dir, out, seen, depth) {
    if (depth > 5) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          this.walk(full, out, seen, depth + 1);
          continue;
        }
        const ext = path.extname(name).toLowerCase();
        if (![".json", ".png"].includes(ext)) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        let nodeCount = 0;
        let description;
        let missingNodes = [];
        let format = "json";
        let seed;
        let modelUsed;
        let params = {};
        let version = "1.0";
        const id = crypto.createHash("sha1").update(full).digest("hex").slice(0, 16);
        if (ext === ".json") {
          const parsed = parseWorkflowJson(fs.readFileSync(full, "utf-8"));
          if (parsed) {
            const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
            nodeCount = nodes.length;
            description = typeof parsed.name === "string" ? parsed.name : void 0;
            version = String(parsed.version || "1.0");
            missingNodes = nodes.filter((n) => typeof n?.type === "string" && n.type.startsWith("Missing")).map((n) => n.type);
            for (const n of nodes) {
              const w = n.widgets_values;
              if (Array.isArray(w)) {
                for (const v of w) {
                  if (typeof v === "number" && Number.isInteger(v) && v > 1 && v < 2 ** 32) {
                    seed = seed ?? v;
                  }
                }
              }
              if (typeof n.title === "string" && /model|checkpoint|unet/i.test(n.title)) {
                modelUsed = modelUsed || String(n.title);
              }
            }
            params = {
              nodeTypes: [...new Set(nodes.map((n) => n.type))].slice(0, 50)
            };
          }
        } else {
          format = "png";
          const buf = fs.readFileSync(full);
          const textMeta = extractPngTextMeta(buf);
          if (textMeta.prompt) {
            try {
              const prompt = JSON.parse(String(textMeta.prompt));
              nodeCount = Object.keys(prompt).length;
              params = { promptKeys: Object.keys(prompt).slice(0, 30) };
            } catch {
            }
          }
          if (textMeta.workflow) {
            try {
              const wf = JSON.parse(String(textMeta.workflow));
              if (Array.isArray(wf.nodes)) nodeCount = wf.nodes.length;
            } catch {
            }
          }
          if (textMeta.seed) seed = Number(textMeta.seed);
          if (textMeta.model) modelUsed = String(textMeta.model);
          params = { ...params, pngMeta: Object.keys(textMeta) };
        }
        out.push({
          id,
          name: path.basename(name, ext),
          path: full,
          format,
          nodeCount,
          tags: [],
          description,
          updatedAt: st.mtimeMs,
          missingNodes,
          version,
          seed,
          modelUsed,
          params
        });
      } catch {
      }
    }
  }
  async importFile(path$1) {
    const st = fs.statSync(path$1);
    const id = crypto.createHash("sha1").update(path$1).digest("hex").slice(0, 16);
    const rec = {
      id,
      name: path.basename(path$1, path.extname(path$1)),
      path: path$1,
      format: path.extname(path$1).toLowerCase() === ".png" ? "png" : "json",
      nodeCount: 0,
      tags: [],
      updatedAt: st.mtimeMs,
      missingNodes: [],
      version: "1.0",
      params: {}
    };
    upsertWorkflow(rec);
    this.list();
    return listWorkflows().find((w) => w.path === path$1) || rec;
  }
  async tag(id, tags) {
    const all = listWorkflows();
    const rec = all.find((w) => w.id === id || w.path === id);
    if (!rec) throw new Error("Workflow not found");
    const next = { ...rec, tags };
    upsertWorkflow(next);
    return next;
  }
  async queue(opts) {
    const instances = loadInstanceConfigs();
    const inst = instances.find((i) => i.id === opts.instanceId) || instances[0];
    if (!inst) throw new Error("No instance configured");
    const url = `http://${inst.listen === "0.0.0.0" ? "127.0.0.1" : inst.listen}:${inst.port}`;
    let rawJson = null;
    const ext = path.extname(opts.workflowPath).toLowerCase();
    if (ext === ".png") {
      const meta = extractPngTextMeta(fs.readFileSync(opts.workflowPath));
      if (meta.prompt) {
        try {
          rawJson = JSON.parse(String(meta.prompt));
        } catch {
          rawJson = null;
        }
      }
      if (!rawJson && meta.workflow) {
        try {
          rawJson = JSON.parse(String(meta.workflow));
        } catch {
          rawJson = null;
        }
      }
    } else {
      rawJson = parseWorkflowJson(fs.readFileSync(opts.workflowPath, "utf-8"));
    }
    if (!rawJson) throw new Error("Cannot parse workflow prompt");
    const { toApiPrompt, applySeedToPrompt } = await Promise.resolve().then(() => require("./chunks/workflowConvert-Dq9kDn_D.js"));
    let prompt = toApiPrompt(rawJson);
    if (opts.seed != null) prompt = applySeedToPrompt(prompt, opts.seed);
    const client = new ComfyApiClient(url);
    const { COMFY_CLIENT_ID: COMFY_CLIENT_ID2 } = await Promise.resolve().then(() => comfyApi);
    const promptId = await client.queuePrompt(prompt, COMFY_CLIENT_ID2);
    if (!promptId) {
      throw new Error("ComfyUI rejected prompt (check instance is running and workflow is valid)");
    }
    return promptId;
  }
  async parsePngMeta(path2) {
    if (!fs.existsSync(path2)) return null;
    const buf = fs.readFileSync(path2);
    return extractPngTextMeta(buf);
  }
  listCached() {
    return listWorkflows();
  }
}
const workflowService = new WorkflowService();
class MonitorService extends events.EventEmitter {
  last = null;
  ws = null;
  wsBaseUrl = "";
  reconnectTimer = null;
  reconnectAttempts = 0;
  async systemSnapshot() {
    const [cpu, mem, fsSize, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.graphics()
    ]);
    const gpus = (graphics.controllers || []).map((c, index) => ({
      index,
      model: c.model || "Unknown GPU",
      vendor: c.vendor || "unknown",
      vramTotal: (c.vram || 0) * 1024 * 1024,
      vramUsed: (c.memoryUsed || 0) > 0 ? (c.memoryUsed || 0) * 1024 * 1024 : 0,
      utilization: c.utilizationGpu || 0,
      temperature: c.temperatureGpu || void 0,
      powerDraw: (c.powerDraw || 0) > 0 ? c.powerDraw : void 0
    }));
    const root = fsSize[0];
    const snapshot = {
      cpuUsage: Math.round(cpu.currentLoad * 10) / 10,
      ramTotal: mem.total,
      ramUsed: mem.used,
      diskFree: root?.available || 0,
      diskTotal: root?.size || 0,
      gpus,
      timestamp: Date.now()
    };
    this.last = snapshot;
    return snapshot;
  }
  getLastSnapshot() {
    return this.last;
  }
  async queueSnapshot(baseUrl) {
    const empty = { running: [], pending: [], doneCount: 0, history: [] };
    if (!baseUrl) return empty;
    const client = new ComfyApiClient(baseUrl);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/queue`, {
        signal: AbortSignal.timeout(2e3)
      });
      if (!res.ok) return empty;
      const data = await res.json();
      const history = await client.history(10);
      return {
        running: (data.queue_running || []).map((item) => {
          const promptId = Array.isArray(item) ? String(item[1] ?? item[0]) : String(item);
          return { promptId, status: "running", progress: 0 };
        }),
        pending: (data.queue_pending || []).map((item) => {
          const promptId = Array.isArray(item) ? String(item[1] ?? item[0]) : String(item);
          return { promptId, status: "pending" };
        }),
        doneCount: history.length,
        history: history.map((h) => ({
          promptId: h.promptId,
          status: h.status,
          completedAt: h.completedAt
        }))
      };
    } catch {
      return empty;
    }
  }
  async history(baseUrl) {
    return this.queueSnapshot(baseUrl);
  }
  connectWs(baseUrl) {
    this.disconnectWs();
    this.reconnectAttempts = 0;
    this.wsBaseUrl = baseUrl;
    return this.openWs(baseUrl);
  }
  openWs(baseUrl) {
    const wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws?clientId=" + COMFY_CLIENT_ID;
    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.on("open", () => {
        this.reconnectAttempts = 0;
        this.emit("ws", { type: "status", text: "connected" });
      });
      ws.on("message", (raw) => {
        try {
          const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          if (buf.length > 0 && buf[0] === 0) return;
          const msg = JSON.parse(buf.toString("utf-8"));
          const evt = {
            type: msg.type,
            nodeId: msg.data?.node ? String(msg.data.node) : void 0,
            value: msg.data?.value,
            max: msg.data?.max,
            promptId: msg.data?.prompt_id ? String(msg.data.prompt_id) : void 0,
            text: msg.data?.text ? String(msg.data.text) : void 0
          };
          this.emit("ws", evt);
        } catch {
        }
      });
      ws.on("close", () => {
        this.emit("ws", { type: "status", text: "disconnected" });
        this.scheduleReconnect();
      });
      ws.on("error", () => {
        this.emit("ws", { type: "status", text: "error" });
        this.scheduleReconnect();
      });
      return true;
    } catch {
      this.scheduleReconnect();
      return false;
    }
  }
  scheduleReconnect() {
    if (!this.wsBaseUrl || this.reconnectAttempts >= 8) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(15e3, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wsBaseUrl) this.openWs(this.wsBaseUrl);
    }, delay);
  }
  disconnectWs() {
    this.wsBaseUrl = "";
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
  }
  isWsConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
const monitorService = new MonitorService();
const execFileAsync$1 = util.promisify(child_process.execFile);
async function safeExec$1(cmd, args, cwd) {
  try {
    const { stdout } = await execFileAsync$1(cmd, args, {
      cwd,
      timeout: 1e4,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024
    });
    return stdout.trim();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "0.0.0.0");
  });
}
class DoctorService {
  async run(instanceId) {
    const started = Date.now();
    const configs = loadInstanceConfigs();
    const config = configs.find((c) => c.id === instanceId) || configs[0];
    const settings = loadSettings();
    const checks = [];
    const installPath = config?.path || settings.defaultInstancePath;
    const hasMain = installPath ? fs.existsSync(path.join(installPath, "main.py")) : false;
    checks.push({
      id: "install-path",
      group: "Environment",
      title: "ComfyUI installation path",
      severity: installPath && hasMain ? "pass" : installPath ? "fail" : "warn",
      detail: installPath ? hasMain ? `Found main.py at ${installPath}` : `Path exists but main.py missing: ${installPath}` : "No instance path configured",
      suggestion: hasMain ? void 0 : "Set the ComfyUI root folder in Instance settings.",
      fixable: false
    });
    const python = config?.venvPath ? fs.existsSync(path.join(config.venvPath, "Scripts", "python.exe")) ? path.join(config.venvPath, "Scripts", "python.exe") : fs.existsSync(path.join(config.venvPath, "bin", "python")) ? path.join(config.venvPath, "bin", "python") : config?.pythonPath || "python" : config?.pythonPath || "python";
    const pyOut = await safeExec$1(python, ["--version"]);
    const pyOk = /python\s+3\.(1[0-9])/i.test(pyOut);
    checks.push({
      id: "python",
      group: "Environment",
      title: "Python interpreter",
      severity: pyOk ? "pass" : "fail",
      detail: pyOut || "Python not found",
      suggestion: pyOk ? void 0 : "Install Python 3.12/3.13 and point the instance to it.",
      fixable: false
    });
    const torchOut = await safeExec$1(python, [
      "-c",
      "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"
    ]);
    const torchOk = /True|^\d+\./.test(torchOut) && !/Error|Traceback|No module/i.test(torchOut);
    checks.push({
      id: "torch",
      group: "Runtime",
      title: "PyTorch & CUDA",
      severity: torchOk ? "pass" : "warn",
      detail: torchOut || "torch not importable",
      suggestion: torchOk ? void 0 : "Install a torch build matching your GPU driver (cu130+ recommended for NVIDIA 20+).",
      fixable: false
    });
    const modelRoot = installPath ? path.join(installPath, "models") : "";
    const hasModels = modelRoot && fs.existsSync(modelRoot);
    checks.push({
      id: "models-dir",
      group: "Storage",
      title: "Models directory",
      severity: hasModels ? "pass" : "warn",
      detail: hasModels ? `Found ${modelRoot}` : "models directory not found",
      suggestion: hasModels ? void 0 : "Create models/ under the ComfyUI root or configure extra_model_paths.yaml.",
      fixable: !hasModels && Boolean(installPath),
      fixId: "create-models-dir"
    });
    const customNodes = installPath ? path.join(installPath, "custom_nodes") : "";
    const hasCN = customNodes && fs.existsSync(customNodes);
    checks.push({
      id: "custom-nodes",
      group: "Extensions",
      title: "custom_nodes directory",
      severity: hasCN ? "pass" : "warn",
      detail: hasCN ? `Found ${customNodes}` : "custom_nodes missing",
      fixable: !hasCN && Boolean(installPath),
      fixId: "create-custom-nodes"
    });
    const emp = installPath ? path.join(installPath, "extra_model_paths.yaml") : "";
    const hasEmp = emp && fs.existsSync(emp);
    let empPaths = [];
    if (hasEmp) {
      empPaths = parseExtraModelPaths(emp, true);
      const broken = empPaths.filter((p) => !fs.existsSync(p));
      checks.push({
        id: "extra-paths",
        group: "Storage",
        title: "extra_model_paths.yaml",
        severity: broken.length ? "warn" : "pass",
        detail: broken.length ? `Broken paths (${broken.length}): ${broken.slice(0, 3).join(", ")}${broken.length > 3 ? "…" : ""}` : `OK, ${empPaths.length} extra roots`,
        suggestion: broken.length ? "Remove or fix missing paths in extra_model_paths.yaml." : void 0,
        fixable: false
      });
    } else {
      checks.push({
        id: "extra-paths",
        group: "Storage",
        title: "extra_model_paths.yaml",
        severity: "info",
        detail: "Not present (optional)",
        suggestion: "Add shared model paths if you use A1111/Forge folders.",
        fixable: Boolean(installPath),
        fixId: "write-extra-model-paths"
      });
    }
    const port = config?.port || 8188;
    const portBusy = await isPortInUse(port);
    checks.push({
      id: "port",
      group: "Network",
      title: "Listen address / port",
      severity: portBusy && config ? "warn" : "pass",
      detail: `${config?.listen || "127.0.0.1"}:${port}${portBusy ? " (currently in use)" : ""}`,
      suggestion: portBusy ? "Port is in use — stop the conflicting process or choose another port." : void 0,
      fixable: false
    });
    if (hasCN && customNodes) {
      try {
        const { readdirSync } = await import("fs");
        const packs = readdirSync(customNodes).filter((n) => !n.startsWith("."));
        const broken = [];
        for (const name of packs.slice(0, 30)) {
          const dir = path.join(customNodes, name);
          const hasEntry = fs.existsSync(path.join(dir, "__init__.py")) || fs.existsSync(path.join(dir, "pyproject.toml")) || fs.existsSync(path.join(dir, "requirements.txt"));
          if (!hasEntry) broken.push(name);
        }
        checks.push({
          id: "cn-count",
          group: "Extensions",
          title: "Custom node packs",
          severity: broken.length ? "warn" : "pass",
          detail: broken.length ? `${packs.length} packs, ${broken.length} missing entry: ${broken.slice(0, 3).join(", ")}` : `${packs.length} packs found`,
          suggestion: broken.length ? "Remove or repair packs without __init__.py/pyproject.toml." : void 0,
          fixable: false
        });
      } catch {
      }
    }
    if (installPath) {
      try {
        const { statfsSync } = await import("fs");
        const modelsDir = path.join(installPath, "models");
        const outputDir = path.join(installPath, "output");
        for (const [label, dir] of [
          ["models", modelsDir],
          ["output", outputDir]
        ]) {
          if (!fs.existsSync(dir)) continue;
          const st = statfsSync(dir);
          const free = Number(st.bsize) * Number(st.bavail);
          const total = Number(st.bsize) * Number(st.blocks);
          const freeGb = (free / 1024 ** 3).toFixed(1);
          const low = free < 5 * 1024 ** 3;
          checks.push({
            id: `disk-${label}`,
            group: "Storage",
            title: `Disk free (${label})`,
            severity: low ? "warn" : "pass",
            detail: `${freeGb} GB free of ${(total / 1024 ** 3).toFixed(1)} GB`,
            suggestion: low ? "Low disk space — free up space before large model downloads." : void 0,
            fixable: false
          });
        }
      } catch {
      }
    }
    if (settings.downloadDir && fs.existsSync(settings.downloadDir)) {
      try {
        fs.statSync(settings.downloadDir);
        checks.push({
          id: "download-dir",
          group: "Storage",
          title: "Download directory",
          severity: "pass",
          detail: settings.downloadDir,
          fixable: false
        });
      } catch {
      }
    }
    let registryOk = false;
    try {
      const res = await fetch(`${REGISTRY_API}/nodes?limit=1`, {
        signal: AbortSignal.timeout(5e3)
      });
      registryOk = res.ok;
    } catch {
      registryOk = false;
    }
    checks.push({
      id: "registry",
      group: "Network",
      title: "Comfy Registry connectivity",
      severity: registryOk ? "pass" : settings.networkMode === "offline" ? "info" : "warn",
      detail: registryOk ? `Reachable ${REGISTRY_API}` : settings.networkMode === "offline" ? "Offline mode — skip registry checks" : "Cannot reach Comfy Registry",
      suggestion: registryOk || settings.networkMode === "offline" ? void 0 : "Check proxy/firewall or set GitHub/HF endpoint in Settings.",
      fixable: false
    });
    const managerEnabled = Boolean(config?.extraArgs?.some((a) => a.includes("enable-manager")));
    checks.push({
      id: "manager",
      group: "Extensions",
      title: "ComfyUI-Manager flag",
      severity: managerEnabled ? "pass" : "info",
      detail: managerEnabled ? "--enable-manager present" : "Manager not forced on launch",
      suggestion: managerEnabled ? void 0 : "Enable Manager launch template if you use it.",
      fixable: false
    });
    if (installPath) {
      const req = path.join(installPath, "requirements.txt");
      checks.push({
        id: "requirements",
        group: "Environment",
        title: "requirements.txt",
        severity: fs.existsSync(req) ? "pass" : "warn",
        detail: fs.existsSync(req) ? req : "requirements.txt missing",
        fixable: false
      });
    }
    const summary = {
      pass: checks.filter((c) => c.severity === "pass").length,
      warn: checks.filter((c) => c.severity === "warn").length,
      fail: checks.filter((c) => c.severity === "fail").length,
      info: checks.filter((c) => c.severity === "info").length
    };
    return {
      id: crypto.randomUUID(),
      instanceId: instanceId || "default",
      createdAt: Date.now(),
      durationMs: Date.now() - started,
      checks,
      summary
    };
  }
  async fix(instanceId, fixId) {
    const configs = loadInstanceConfigs();
    const config = configs.find((c) => c.id === instanceId) || configs[0];
    const settings = loadSettings();
    const installPath = config?.path || settings.defaultInstancePath;
    if (!installPath) return { ok: false, message: "No instance path" };
    switch (fixId) {
      case "create-models-dir": {
        const dir = path.join(installPath, "models");
        fs.mkdirSync(dir, { recursive: true });
        for (const sub of ["checkpoints", "loras", "vae", "clip", "controlnet", "upscale_models", "embeddings", "unet", "diffusion_models"]) {
          fs.mkdirSync(path.join(dir, sub), { recursive: true });
        }
        return { ok: true, message: `Created models tree at ${dir}` };
      }
      case "create-custom-nodes": {
        const dir = path.join(installPath, "custom_nodes");
        fs.mkdirSync(dir, { recursive: true });
        return { ok: true, message: `Created ${dir}` };
      }
      case "unpin-torch": {
        try {
          const { readdirSync } = await import("fs");
          const customNodes = path.join(installPath, "custom_nodes");
          if (!fs.existsSync(customNodes)) return { ok: false, message: "custom_nodes missing" };
          let fixed = 0;
          for (const name of readdirSync(customNodes)) {
            const req = path.join(customNodes, name, "requirements.txt");
            if (!fs.existsSync(req)) continue;
            const text = fs.readFileSync(req, "utf-8");
            const next = text.replace(/torch\s*==\s*[^\s;]+/gi, "torch>=2.0");
            if (next !== text) {
              fs.writeFileSync(req, next);
              fixed += 1;
            }
          }
          return {
            ok: true,
            message: fixed ? `Relaxed torch pins in ${fixed} requirements.txt` : "No exact torch pins found"
          };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      }
      case "write-extra-model-paths": {
        const file = path.join(installPath, "extra_model_paths.yaml");
        if (!fs.existsSync(file)) {
          fs.writeFileSync(
            file,
            `# ComfyPilot generated
comfyui:
  base_path: ${installPath.replace(/\\/g, "/")}
  checkpoints: models/checkpoints
  loras: models/loras
  vae: models/vae
`
          );
          return { ok: true, message: `Wrote ${file}` };
        }
        return { ok: true, message: "extra_model_paths.yaml already exists" };
      }
      default:
        return { ok: false, message: `Unknown fix: ${fixId}` };
    }
  }
}
const doctorService = new DoctorService();
function resolveBackupDir(id) {
  const safe = sanitizeId(id);
  const dir = path.join(backupDir(), safe);
  if (!isPathInside(dir, backupDir())) {
    throw new Error("Invalid backup id");
  }
  return dir;
}
class BackupService {
  list() {
    return listBackups();
  }
  create(opts) {
    const id = sanitizeId(crypto.randomUUID());
    const dir = path.join(backupDir(), id);
    fs.mkdirSync(dir, { recursive: true });
    const settings = loadSettings();
    const instances = loadInstanceConfigs();
    const nodePacks = listNodePacks();
    const models = listModels();
    const workflows = listWorkflows();
    const remotes = listRemotes();
    const files = {
      "settings.json": settings,
      "instances.json": instances,
      "node-packs.json": nodePacks,
      "model-manifest.json": models,
      "workflows.json": workflows,
      "remote-instances.json": remotes
    };
    for (const [name, value] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
    }
    const includes = {
      settings: true,
      instances: true,
      nodePacks: true,
      modelManifest: true,
      workflows: true
    };
    let size = 0;
    for (const f of Object.keys(files)) {
      try {
        size += fs.statSync(path.join(dir, f)).size;
      } catch {
      }
    }
    const manifest = {
      id,
      name: opts.name || `backup-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`,
      createdAt: Date.now(),
      path: dir,
      size,
      includes,
      notes: opts.notes || ""
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    insertBackup(manifest);
    return manifest;
  }
  restore(id) {
    const dir = resolveBackupDir(id);
    if (!fs.existsSync(dir)) return false;
    const settingsFile = path.join(dir, "settings.json");
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      saveSettings(settings);
    }
    const instFile = path.join(dir, "instances.json");
    if (fs.existsSync(instFile)) {
      const instances = JSON.parse(fs.readFileSync(instFile, "utf-8"));
      for (const i of instances) upsertInstanceConfig(i);
    }
    const nodeFile = path.join(dir, "node-packs.json");
    if (fs.existsSync(nodeFile)) {
      const packs = JSON.parse(fs.readFileSync(nodeFile, "utf-8"));
      for (const p of packs) upsertNodePack(p);
    }
    const modelFile = path.join(dir, "model-manifest.json");
    if (fs.existsSync(modelFile)) {
      const models = JSON.parse(fs.readFileSync(modelFile, "utf-8"));
      for (const m of models) upsertModel(m);
    }
    const wfFile = path.join(dir, "workflows.json");
    if (fs.existsSync(wfFile)) {
      const workflows = JSON.parse(fs.readFileSync(wfFile, "utf-8"));
      for (const w of workflows) upsertWorkflow(w);
    }
    const remoteFile = path.join(dir, "remote-instances.json");
    if (fs.existsSync(remoteFile)) {
      const remotes = JSON.parse(fs.readFileSync(remoteFile, "utf-8"));
      for (const r of remotes) upsertRemote(r);
    }
    return true;
  }
  delete(id) {
    const dir = resolveBackupDir(id);
    try {
      if (fs.existsSync(dir) && isPathInside(dir, backupDir())) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
    }
    return deleteBackup(sanitizeId(id));
  }
  openFolder(id) {
    return resolveBackupDir(id);
  }
}
const backupService = new BackupService();
const execFileAsync = util.promisify(child_process.execFile);
async function safeExec(cmd, args, cwd, timeoutMs = 2e4) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const LONG_TIMEOUT_MS = 30 * 60 * 1e3;
class EnvService {
  async probe(opts) {
    const pythonPath = opts.venvPath && fs.existsSync(path.join(opts.venvPath, "Scripts", "python.exe")) ? path.join(opts.venvPath, "Scripts", "python.exe") : opts.venvPath && fs.existsSync(path.join(opts.venvPath, "bin", "python")) ? path.join(opts.venvPath, "bin", "python") : opts.pythonPath;
    const errors = [];
    const versionOut = await safeExec(pythonPath, ["--version"]);
    const pythonVersion = versionOut;
    if (!/Python/i.test(versionOut)) errors.push(versionOut || "python not found");
    let torchVersion;
    let cudaVersion;
    let rocmVersion;
    let mpsAvailable;
    let npuAvailable;
    const packages = [];
    const torchScript = [
      "import json, torch",
      "print(json.dumps({",
      '"torch": getattr(torch, "__version__", ""),',
      '"cuda": getattr(torch.version, "cuda", None),',
      '"rocm": getattr(torch.version, "hip", None),',
      '"mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),',
      '"npu": hasattr(torch, "npu") and torch.npu.is_available()',
      "}))"
    ].join(";");
    const torchOut = await safeExec(pythonPath, ["-c", torchScript]);
    try {
      const data = JSON.parse(torchOut.trim().split("\n").pop() || "{}");
      torchVersion = data.torch;
      cudaVersion = data.cuda || void 0;
      rocmVersion = data.rocm || void 0;
      mpsAvailable = Boolean(data.mps);
      npuAvailable = Boolean(data.npu);
      packages.push({ name: "torch", version: data.torch || "" });
    } catch {
      errors.push("torch probe failed: " + torchOut.slice(0, 120));
    }
    const pipOut = await safeExec(pythonPath, ["-m", "pip", "list", "--format=json"]);
    try {
      const list = JSON.parse(pipOut.trim().split("\n").pop() || "[]");
      packages.push(...list.slice(0, 300));
    } catch {
    }
    return {
      pythonPath,
      pythonVersion,
      venvPath: opts.venvPath,
      torchVersion,
      cudaVersion,
      rocmVersion,
      mpsAvailable,
      npuAvailable,
      packages,
      ok: errors.length === 0,
      errors
    };
  }
  async createVenv(req) {
    fs.mkdirSync(req.basePath, { recursive: true });
    const venvPath = path.join(req.basePath, req.name);
    if (req.useUv) {
      await safeExec("uv", ["venv", venvPath, "--python", req.pythonPath], void 0, LONG_TIMEOUT_MS);
    } else {
      await safeExec(req.pythonPath, ["-m", "venv", venvPath], void 0, LONG_TIMEOUT_MS);
    }
    const python = fs.existsSync(path.join(venvPath, "Scripts", "python.exe")) ? path.join(venvPath, "Scripts", "python.exe") : path.join(venvPath, "bin", "python");
    if (req.torchIndex) {
      await safeExec(
        python,
        ["-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", req.torchIndex],
        void 0,
        LONG_TIMEOUT_MS
      );
    }
    return this.probe({ pythonPath: python, venvPath });
  }
  async listPythons() {
    const candidates = ["python", "python3", "py"];
    const out = [];
    for (const cmd of candidates) {
      const v = await safeExec(cmd, ["--version"]);
      if (/Python/i.test(v)) out.push({ path: cmd, version: v });
    }
    for (const p of [
      "C:\\Python313\\python.exe",
      "C:\\Python312\\python.exe",
      "C:\\Python311\\python.exe",
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python313", "python.exe")
    ]) {
      if (p && fs.existsSync(p)) {
        const v = await safeExec(p, ["--version"]);
        out.push({ path: p, version: v });
      }
    }
    return out;
  }
  async installTorch(opts) {
    const out = await safeExec(
      opts.pythonPath,
      [
        "-m",
        "pip",
        "install",
        "torch",
        "torchvision",
        "torchaudio",
        "--index-url",
        opts.index
      ],
      void 0,
      LONG_TIMEOUT_MS
    );
    const ok2 = /Successfully installed|already satisfied|Requirement already satisfied/i.test(out);
    if (!ok2) {
      throw new Error(`pip install torch failed: ${out.slice(0, 300)}`);
    }
    return true;
  }
}
const envService = new EnvService();
class BatchService extends events.EventEmitter {
  list() {
    return listBatchJobs();
  }
  create(job) {
    const rec = {
      ...job,
      id: crypto.randomUUID(),
      status: "queued",
      completed: 0,
      failed: 0,
      createdAt: Date.now(),
      promptIds: []
    };
    upsertBatchJob(rec);
    return rec;
  }
  async start(id) {
    const jobs = listBatchJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error("Batch job not found");
    job.status = "running";
    upsertBatchJob(job);
    this.emit("progress", job);
    const instances = loadInstanceConfigs();
    const inst = instances.find((i) => i.id === job.instanceId) || instances[0];
    if (!inst) {
      job.status = "error";
      job.finishedAt = Date.now();
      upsertBatchJob(job);
      throw new Error("No instance");
    }
    const url = `http://${inst.listen === "0.0.0.0" ? "127.0.0.1" : inst.listen}:${inst.port}`;
    const client = new ComfyApiClient(url);
    let prompt = null;
    try {
      const raw = fs.readFileSync(job.workflowPath, "utf-8");
      try {
        prompt = JSON.parse(raw);
      } catch {
        prompt = null;
      }
      if (!prompt && path.extname(job.workflowPath).toLowerCase() === ".png") {
        try {
          const meta = extractPngTextMeta(fs.readFileSync(job.workflowPath));
          if (meta.prompt) prompt = JSON.parse(String(meta.prompt));
        } catch {
          prompt = null;
        }
      }
    } catch {
      prompt = null;
    }
    if (!prompt) {
      job.status = "error";
      job.finishedAt = Date.now();
      upsertBatchJob(job);
      throw new Error("Cannot parse workflow");
    }
    try {
      const { toApiPrompt, applySeedForIteration } = await Promise.resolve().then(() => require("./chunks/workflowConvert-Dq9kDn_D.js"));
      const { COMFY_CLIENT_ID: COMFY_CLIENT_ID2 } = await Promise.resolve().then(() => comfyApi);
      const baseSeed = Date.now() % 2 ** 32;
      for (let i = 0; i < job.count; i++) {
        const current = listBatchJobs().find((j) => j.id === id);
        if (current?.status === "cancelled") {
          job.status = "cancelled";
          job.finishedAt = Date.now();
          upsertBatchJob(job);
          this.emit("progress", job);
          return job;
        }
        const promptForRun = applySeedForIteration(toApiPrompt(prompt), baseSeed, i);
        try {
          const promptId = await client.queuePrompt(promptForRun, COMFY_CLIENT_ID2);
          if (promptId) {
            job.promptIds.push(promptId);
            job.completed += 1;
          } else {
            job.failed += 1;
          }
        } catch {
          job.failed += 1;
        }
        const after = listBatchJobs().find((j) => j.id === id);
        if (after?.status === "cancelled") {
          return after;
        }
        upsertBatchJob(job);
        this.emit("progress", job);
      }
    } catch (e) {
      job.status = "error";
      job.finishedAt = Date.now();
      upsertBatchJob(job);
      throw e;
    }
    const latest = listBatchJobs().find((j) => j.id === id);
    if (latest?.status === "cancelled") {
      return latest;
    }
    job.status = job.failed > 0 && job.completed === 0 ? "error" : "done";
    job.finishedAt = Date.now();
    upsertBatchJob(job);
    this.emit("progress", job);
    return job;
  }
  cancel(id) {
    const job = listBatchJobs().find((j) => j.id === id);
    if (!job) throw new Error("Batch job not found");
    job.status = "cancelled";
    job.finishedAt = Date.now();
    upsertBatchJob(job);
    return job;
  }
  remove(id) {
    return deleteBatchJob(id);
  }
}
const batchService = new BatchService();
class OutputService {
  list(opts) {
    const settings = loadSettings();
    const roots = [opts?.root, settings.outputIndexRoot].filter(Boolean);
    if (!roots.length) return listOutputAssets(opts?.limit || 200);
    const assets = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      this.walk(root, assets, 0);
    }
    for (const a of assets) upsertOutputAsset(a);
    const all = listOutputAssets(opts?.limit || 200);
    return opts?.type ? all.filter((a) => a.type === opts.type) : all;
  }
  walk(dir, out, depth) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          this.walk(full, out, depth + 1);
          continue;
        }
        const ext = path.extname(name).toLowerCase();
        const type = [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) ? "image" : [".mp4", ".webm", ".mov"].includes(ext) ? "video" : [".wav", ".mp3", ".flac"].includes(ext) ? "audio" : "other";
        if (type === "other") continue;
        let params = {};
        let seed;
        let promptId;
        if (type === "image" && ext === ".png") {
          try {
            const meta = extractPngTextMeta(fs.readFileSync(full));
            if (meta.prompt) {
              try {
                const prompt = JSON.parse(String(meta.prompt));
                params.nodeCount = Object.keys(prompt).length;
                for (const node of Object.values(prompt)) {
                  if (node?.inputs && typeof node.inputs.seed === "number" && seed == null) {
                    seed = node.inputs.seed;
                  }
                }
              } catch {
              }
            }
            if (meta.seed && seed == null) seed = Number(meta.seed);
            if (meta.prompt_id) promptId = String(meta.prompt_id);
            params = {
              ...params,
              pngKeys: Object.keys(meta),
              workflow: void 0,
              prompt: void 0
            };
          } catch {
          }
        }
        out.push({
          id: crypto.createHash("sha1").update(full).digest("hex").slice(0, 16),
          path: full,
          fileName: path.basename(full),
          type,
          size: st.size,
          createdAt: st.mtimeMs,
          seed,
          promptId,
          params
        });
      } catch {
      }
    }
  }
  open(path2) {
    return fs.existsSync(path2);
  }
}
const outputService = new OutputService();
class RemoteService {
  list() {
    return listRemotes();
  }
  save(config) {
    upsertRemote(config);
    return config;
  }
  remove(id) {
    return deleteRemote(id);
  }
  async test(id) {
    const remotes = listRemotes();
    const remote = remotes.find((r) => r.id === id);
    if (!remote) throw new Error("Remote not found");
    try {
      const res = await fetch(`${remote.baseUrl.replace(/\/$/, "")}/system_stats`, {
        headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {},
        signal: AbortSignal.timeout(4e3)
      });
      if (!res.ok) return { id, online: false, queueRunning: 0, queuePending: 0, error: `HTTP ${res.status}` };
      const queueRes = await fetch(`${remote.baseUrl.replace(/\/$/, "")}/queue`, {
        signal: AbortSignal.timeout(3e3)
      });
      const queue = await queueRes.json();
      return {
        id,
        online: true,
        queueRunning: queue.queue_running?.length || 0,
        queuePending: queue.queue_pending?.length || 0
      };
    } catch (e) {
      return {
        id,
        online: false,
        queueRunning: 0,
        queuePending: 0,
        error: e instanceof Error ? e.message : String(e)
      };
    }
  }
  async listStatus() {
    const remotes = listRemotes().filter((r) => r.enabled);
    return Promise.all(remotes.map((r) => this.test(r.id)));
  }
}
const remoteService = new RemoteService();
class MarketService {
  async list(opts) {
    const settings = loadSettings();
    try {
      const q = encodeURIComponent(opts?.query || "");
      const url = `https://api.comfy.org/nodes?limit=50${q ? `&search=${q}` : ""}`;
      const res = await fetch(url, {
        headers: { "User-Agent": "ComfyPilot/0.1" },
        signal: AbortSignal.timeout(1e4)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const installed = new Set(
        readdirSafe(settings.defaultInstancePath)
      );
      return (data.nodes || []).map((n) => ({
        id: String(n.id || n.name),
        name: String(n.name || ""),
        displayName: String(n.displayName || n.name),
        description: String(n.description || ""),
        author: String(n.publisher?.name || n.author || ""),
        version: String(n.latest_version || ""),
        category: String(n.category || opts?.category || "tools"),
        tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
        downloads: Number(n.downloads || 0),
        stars: Number(n.stars || n.score || 0),
        installed: installed.has(String(n.name || "")),
        repository: String(n.repository || ""),
        icon: n.icon ? String(n.icon) : void 0,
        rating: Number(n.rating || 4.5)
      }));
    } catch (err) {
      if (settings.networkMode === "offline") return [];
      throw err;
    }
  }
}
function readdirSafe(instancePath) {
  if (!instancePath) return [];
  try {
    const dir = path.join(instancePath, "custom_nodes");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
const marketService = new MarketService();
const EXEC_OPTS = {
  timeout: 30 * 60 * 1e3,
  maxBuffer: 20 * 1024 * 1024
};
const TORCH_INDEX = {
  cu130: "https://download.pytorch.org/whl/cu130",
  cu126: "https://download.pytorch.org/whl/cu126",
  cu124: "https://download.pytorch.org/whl/cu124",
  rocm: "https://download.pytorch.org/whl/rocm6.2",
  xpu: "https://download.pytorch.org/whl/xpu",
  mps: "https://download.pytorch.org/whl/cpu",
  cpu: "https://download.pytorch.org/whl/cpu"
};
const COMFY_REPO = "https://github.com/comfyanonymous/ComfyUI.git";
function nowStep(id, title, status = "pending") {
  return { id, title, status, detail: "", log: [] };
}
function defaultSteps() {
  return [
    nowStep("preflight", "环境预检"),
    nowStep("python", "定位 Python"),
    nowStep("venv", "创建隔离虚拟环境"),
    nowStep("comfyui", "获取 ComfyUI"),
    nowStep("torch", "安装 PyTorch"),
    nowStep("requirements", "安装 ComfyUI 依赖"),
    nowStep("register", "注册实例"),
    nowStep("done", "完成")
  ];
}
function assertSafeGitUrl(url) {
  const u = String(url || "").trim();
  if (!u || u.startsWith("-")) throw new Error("Invalid git URL");
  if (/ext::/i.test(u)) throw new Error("Blocked git transport ext::");
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(u)) {
    throw new Error("Git URL must be https://, ssh:// or git@host:…");
  }
  let authority = "";
  const schemeMatch = u.match(/^(?:https?|ssh):\/\/([^/]+)/i);
  if (schemeMatch) authority = schemeMatch[1];
  else {
    const gitAt = u.match(/^git@([^:]+)/i);
    if (gitAt) authority = gitAt[1];
  }
  const parts = authority.split("@");
  for (const part of parts) {
    if (!part || part.startsWith("-") || /\s/.test(part)) {
      throw new Error("Invalid git host/user");
    }
  }
  return u;
}
function assertSafeBranch(branch) {
  const b = String(branch || "").trim();
  if (!b) return "";
  if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.startsWith("-") || b.includes("..")) {
    throw new Error("Invalid git branch name");
  }
  return b;
}
function buildGitCloneArgs(repo, dest, branch) {
  const safeRepo = assertSafeGitUrl(repo);
  const safeBranch = assertSafeBranch(branch || "");
  const args = ["clone", "--depth", "1"];
  if (safeBranch) args.push("--branch", safeBranch);
  args.push(safeRepo, dest);
  return args;
}
class InstallerService extends events.EventEmitter {
  progress = null;
  cancelled = false;
  running = false;
  children = /* @__PURE__ */ new Set();
  runRejects = /* @__PURE__ */ new Set();
  getStatus() {
    return this.progress;
  }
  cancel() {
    this.cancelled = true;
    const kills = [];
    for (const child of this.children) {
      kills.push(this.killTree(child));
    }
    for (const rej of this.runRejects) {
      try {
        rej(new Error("Installation cancelled"));
      } catch {
      }
    }
    this.runRejects.clear();
    void Promise.allSettled(kills).then(() => this.children.clear());
    return true;
  }
  killTree(child) {
    return new Promise((resolve2) => {
      if (process.platform === "win32" && child.pid) {
        child_process.execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 8e3 },
          () => {
            try {
              if (child.exitCode === null) child.kill("SIGKILL");
            } catch {
            }
            resolve2();
          }
        );
        return;
      }
      try {
        child.kill("SIGTERM");
      } catch {
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {
        }
        resolve2();
      }, 500);
    });
  }
  async run(cmd, args, opts) {
    this.assertNotCancelled();
    return new Promise((resolvePromise, reject) => {
      const onReject = (err) => {
        this.runRejects.delete(onReject);
        reject(err);
      };
      this.runRejects.add(onReject);
      const child = child_process.execFile(
        cmd,
        args,
        {
          cwd: opts?.cwd,
          timeout: opts?.timeout ?? EXEC_OPTS.timeout,
          windowsHide: true,
          maxBuffer: EXEC_OPTS.maxBuffer,
          env: proxyEnv(loadSettings().proxy)
        },
        (err, stdout, stderr) => {
          this.children.delete(child);
          this.runRejects.delete(onReject);
          if (this.cancelled) {
            reject(new Error("Installation cancelled"));
            return;
          }
          if (err) {
            reject(new Error(stderr || stdout || err.message));
            return;
          }
          resolvePromise(stdout);
        }
      );
      this.children.add(child);
    });
  }
  emitProgress(message = "") {
    if (!this.progress) return;
    const total = this.progress.steps.length;
    const done = this.progress.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    this.progress.percent = Math.round(done / total * 100);
    this.progress.message = message;
    this.emit("progress", { ...this.progress });
  }
  setStep(id, status, detail, logLine) {
    if (!this.progress) return;
    const step = this.progress.steps.find((s) => s.id === id);
    if (!step) return;
    step.status = status;
    if (detail != null) step.detail = detail;
    if (logLine) step.log.push(logLine);
    this.progress.step = id;
    this.emitProgress(detail || "");
  }
  log(id, line) {
    if (!this.progress) return;
    const step = this.progress.steps.find((s) => s.id === id);
    if (step) step.log.push(line);
    this.emitProgress(line);
  }
  assertNotCancelled() {
    if (this.cancelled) throw new Error("Installation cancelled");
  }
  async detectGpu() {
    try {
      const graphics = await si.graphics();
      const out = [];
      for (const c of graphics.controllers || []) {
        const model2 = c.model || "Unknown GPU";
        const vendor = (c.vendor || "").toLowerCase();
        let recommendedTorch = "cpu";
        let notes = "";
        if (vendor.includes("nvidia") || /geforce|rtx|gtx|quadro|tesla/i.test(model2)) {
          recommendedTorch = "cu126";
          notes = "NVIDIA — 默认 cu126（10 系/老卡）；20 系以上可改 cu130";
          if (/\b(20|30|40|50)\d{2}\b|rtx/i.test(model2)) {
            recommendedTorch = "cu130";
            notes = "NVIDIA RTX 20 系及以上 — 推荐 cu130";
          }
        } else if (vendor.includes("amd") || /radeon/i.test(model2)) {
          recommendedTorch = process.platform === "linux" ? "rocm" : "cpu";
          notes = process.platform === "linux" ? "AMD ROCm（Linux）" : "Windows AMD 需官方 ROCm PyTorch 包，先回退 CPU 或手动指定";
        } else if (vendor.includes("intel") || /arc|xe/i.test(model2)) {
          recommendedTorch = process.platform === "win32" || process.platform === "linux" ? "xpu" : "cpu";
          notes = "Intel GPU 可用 XPU 构建";
        } else if (process.platform === "darwin") {
          recommendedTorch = "mps";
          notes = "Apple Silicon MPS";
        }
        out.push({ vendor: c.vendor || "unknown", model: model2, recommendedTorch, notes });
      }
      if (!out.length) {
        out.push({
          vendor: "none",
          model: "No GPU detected",
          recommendedTorch: process.platform === "darwin" ? "mps" : "cpu",
          notes: "未检测到独立 GPU，将安装 CPU 版 torch"
        });
      }
      return out;
    } catch {
      return [
        {
          vendor: "unknown",
          model: "GPU detection failed",
          recommendedTorch: "cpu",
          notes: "GPU 探测失败，使用 CPU"
        }
      ];
    }
  }
  async preflight(opts) {
    const checks = [];
    const root = opts.installRoot;
    const rootOk = Boolean(root) && !hasParentHop(root);
    checks.push({
      id: "root",
      ok: rootOk,
      detail: rootOk ? `安装目录 ${root}` : "安装目录非法（含 .. 或为空）"
    });
    try {
      const { statfsSync } = await import("fs");
      const probeDir = fs.existsSync(root) ? root : path.dirname(root);
      if (fs.existsSync(probeDir)) {
        const st = statfsSync(probeDir);
        const freeGb = Number(st.bsize) * Number(st.bavail) / 1024 ** 3;
        checks.push({
          id: "disk",
          ok: freeGb > 8,
          detail: `可用空间 ${freeGb.toFixed(1)} GB（建议 ≥ 8GB，含 torch 约 5–15GB）`
        });
      } else {
        checks.push({ id: "disk", ok: true, detail: "目标目录将新建" });
      }
    } catch {
      checks.push({ id: "disk", ok: true, detail: "磁盘检测不可用" });
    }
    try {
      const out = await this.run("git", ["--version"], { timeout: 5e3 });
      checks.push({ id: "git", ok: true, detail: out.trim() });
    } catch {
      checks.push({
        id: "git",
        ok: false,
        detail: "未找到 git —— 源码安装需要 Git for Windows / git"
      });
    }
    const python = opts.pythonPath && opts.pythonPath.trim() ? opts.pythonPath.trim() : "python";
    try {
      const out = await this.run(python, ["--version"], { timeout: 8e3 });
      const m = out.match(/Python\s+(3)\.(\d+)/i);
      const major = m ? Number(m[1]) : 0;
      const minor = m ? Number(m[2]) : -1;
      const ok2 = major === 3 && minor >= 10;
      checks.push({ id: "python", ok: ok2, detail: out.trim() || python });
    } catch {
      checks.push({
        id: "python",
        ok: false,
        detail: `未找到解释器：${python}（请安装 Python 3.10+ 或改路径）`
      });
    }
    if (opts.useUv) {
      try {
        const out = await this.run("uv", ["--version"], { timeout: 5e3 });
        checks.push({ id: "uv", ok: true, detail: out.trim() });
      } catch {
        checks.push({
          id: "uv",
          ok: false,
          detail: "选择 uv 但未安装 —— 可改用 venv 或先安装 uv"
        });
      }
    }
    return { ok: checks.every((c) => c.ok), checks };
  }
  async start(plan) {
    if (this.running) throw new Error("Installer already running");
    if (!plan.installRoot || hasParentHop(plan.installRoot)) {
      throw new Error("Invalid install root");
    }
    assertSafeGitUrl(plan.comfyRepo || COMFY_REPO);
    assertSafeBranch(plan.comfyBranch || "");
    this.running = true;
    this.cancelled = false;
    const runId = crypto.randomUUID();
    this.progress = {
      runId,
      step: "preflight",
      status: "running",
      steps: defaultSteps(),
      message: "开始安装",
      percent: 0
    };
    this.emitProgress("开始安装");
    void this.runPlan(plan).finally(() => {
      this.running = false;
    });
    return { runId };
  }
  resolvePython(plan) {
    if (plan.pythonPath && plan.pythonPath.trim()) return plan.pythonPath.trim();
    return "python";
  }
  venvPython(venvPath) {
    const win = path.join(venvPath, "Scripts", "python.exe");
    const unix = path.join(venvPath, "bin", "python");
    return fs.existsSync(win) ? win : unix;
  }
  async runPlan(plan) {
    try {
      const installRoot = path.resolve(normalizePathEverySegment(plan.installRoot));
      if (hasParentHop(plan.installRoot)) throw new Error("Invalid install root");
      this.setStep("preflight", "running", "检查本机环境…");
      const pythonForPlan = this.resolvePython(plan);
      const pre = await this.preflight({
        installRoot: plan.installRoot,
        useUv: plan.useUv,
        pythonPath: pythonForPlan
      });
      for (const c of pre.checks) this.log("preflight", `${c.ok ? "✓" : "✗"} ${c.id}: ${c.detail}`);
      if (!pre.ok) {
        throw new Error("预检未通过：" + pre.checks.filter((c) => !c.ok).map((c) => c.detail).join("; "));
      }
      this.setStep("preflight", "done", "预检通过");
      this.assertNotCancelled();
      this.setStep("python", "running", "定位 Python…");
      const python = pythonForPlan;
      const pyVer = await this.run(python, ["--version"], { timeout: 8e3 });
      this.setStep("python", "done", pyVer.trim() || python);
      this.assertNotCancelled();
      fs.mkdirSync(installRoot, { recursive: true });
      const venvPath = path.join(installRoot, ".venv");
      this.setStep("venv", "running", plan.useUv ? "uv 创建虚拟环境…" : "python -m venv …");
      if (plan.useUv) {
        await this.run("uv", ["venv", venvPath, "--python", python], { timeout: 12e4 });
      } else {
        await this.run(python, ["-m", "venv", venvPath], { timeout: 12e4 });
      }
      const vpy = this.venvPython(venvPath);
      if (!fs.existsSync(vpy)) throw new Error(`虚拟环境创建失败，找不到 ${vpy}`);
      this.setStep("venv", "done", `隔离环境 ${venvPath}`);
      this.assertNotCancelled();
      const comfyDir = path.join(installRoot, "ComfyUI");
      this.setStep("comfyui", "running", "克隆 ComfyUI…");
      if (fs.existsSync(path.join(comfyDir, "main.py"))) {
        this.log("comfyui", "已存在 ComfyUI，跳过克隆");
        if (plan.comfyBranch) {
          this.log("comfyui", `注意：已复用现有目录，未切换到分支 ${plan.comfyBranch}`);
        }
        this.setStep("comfyui", "done", "复用已有 ComfyUI");
      } else {
        const repo = plan.comfyRepo || COMFY_REPO;
        const branch = plan.comfyBranch || "";
        const args = buildGitCloneArgs(repo, comfyDir, branch);
        await this.run("git", args, { timeout: 3e5 });
        if (!fs.existsSync(path.join(comfyDir, "main.py"))) throw new Error("ComfyUI 克隆后未找到 main.py");
        this.setStep("comfyui", "done", `已克隆 ${repo}`);
      }
      this.assertNotCancelled();
      this.setStep("torch", "running", `安装 PyTorch (${plan.torchChannel})…`);
      const index = TORCH_INDEX[plan.torchChannel] || TORCH_INDEX.cpu;
      if (plan.useUv) {
        await this.run(
          "uv",
          ["pip", "install", "--python", vpy, "torch", "torchvision", "torchaudio", "--index-url", index],
          { timeout: 30 * 60 * 1e3 }
        );
      } else {
        await this.run(vpy, ["-m", "pip", "install", "--upgrade", "pip"], { timeout: 12e4 });
        await this.run(
          vpy,
          ["-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", index],
          { timeout: 30 * 60 * 1e3 }
        );
      }
      this.log("torch", `torch index: ${index}`);
      this.setStep("torch", "done", plan.torchChannel);
      this.assertNotCancelled();
      this.setStep("requirements", "running", "安装 ComfyUI requirements…");
      const reqFile = path.join(comfyDir, "requirements.txt");
      if (fs.existsSync(reqFile)) {
        if (plan.useUv) {
          await this.run("uv", ["pip", "install", "--python", vpy, "-r", reqFile], {
            timeout: 30 * 60 * 1e3
          });
        } else {
          await this.run(vpy, ["-m", "pip", "install", "-r", reqFile], {
            timeout: 30 * 60 * 1e3
          });
        }
        this.setStep("requirements", "done", "requirements 已安装到隔离环境");
      } else {
        this.setStep("requirements", "skipped", "未找到 requirements.txt");
      }
      this.assertNotCancelled();
      this.setStep("register", "running", "写入实例配置…");
      const existing = loadInstanceConfigs();
      const samePath = existing.find(
        (c) => path.resolve(normalizePathEverySegment(c.path)) === path.resolve(comfyDir)
      );
      const config = {
        id: samePath?.id || crypto.randomUUID(),
        name: plan.instanceName || "ComfyUI",
        path: comfyDir,
        pythonPath: "",
        venvPath,
        port: samePath?.port || await this.pickPort(),
        listen: "127.0.0.1",
        extraArgs: [],
        argTemplateId: "default",
        enabled: true,
        notes: "Created by ComfyPilot one-click installer (isolated venv)",
        autoStart: Boolean(plan.autoStart),
        frontendVersion: ""
      };
      upsertInstanceConfig(config);
      fs.writeFileSync(
        path.join(installRoot, ".comfypilot-env.json"),
        JSON.stringify(
          {
            venvPath,
            torchChannel: plan.torchChannel,
            python,
            createdAt: Date.now(),
            isolated: true
          },
          null,
          2
        )
      );
      this.setStep("register", "done", config.name);
      if (plan.autoStart) {
        try {
          this.log("done", "自动启动实例…");
          const { instanceService: instanceService2 } = await Promise.resolve().then(() => instance);
          await instanceService2.start(config.id);
          this.setStep("done", "done", "安装完成并已启动");
        } catch (e) {
          this.log("done", `自动启动失败：${e instanceof Error ? e.message : String(e)}`);
          this.setStep("done", "done", "安装完成（自动启动失败，可手动启动）");
        }
      } else {
        this.setStep("done", "done", "安装完成，可一键启动");
      }
      if (this.progress) {
        this.progress.status = "done";
        this.progress.percent = 100;
        this.progress.message = "安装完成";
      }
      this.emitProgress("安装完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = this.cancelled || message === "Installation cancelled" || /Installation cancelled/i.test(message);
      if (this.progress) {
        this.progress.status = "failed";
        this.progress.error = cancelled ? "Installation cancelled" : message;
        this.progress.message = this.progress.error;
        const running = this.progress.steps.find((s) => s.status === "running");
        if (running) {
          running.status = "failed";
          running.detail = this.progress.error;
          running.log.push("✗ " + this.progress.error);
        }
      }
      this.emitProgress(message);
    } finally {
      this.children.clear();
    }
  }
  async pickPort() {
    const net2 = await import("net");
    const tryPort = (port) => new Promise((resolvePort) => {
      const server = net2.createServer();
      server.once("error", () => resolvePort(false));
      server.once("listening", () => server.close(() => resolvePort(true)));
      server.listen(port, "127.0.0.1");
    });
    for (const p of [8188, 8189, 8190, 8191, 8288]) {
      if (await tryPort(p)) return p;
    }
    return 8388;
  }
}
const installerService = new InstallerService();
const installer = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  COMFY_REPO,
  InstallerService,
  TORCH_INDEX,
  assertSafeBranch,
  assertSafeGitUrl,
  buildGitCloneArgs,
  installerService
}, Symbol.toStringTag, { value: "Module" }));
function ok(data) {
  return { ok: true, data };
}
function fail(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
function wrap(fn) {
  return async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  };
}
let embedView = null;
function registerIpcHandlers(getWindow) {
  electron.ipcMain.handle("settings.get", wrap(() => loadSettings()));
  electron.ipcMain.handle("settings.set", wrap((patch) => {
    const next = saveSettings(patch);
    syncProxyFromSettings();
    return next;
  }));
  electron.ipcMain.handle("settings.launchTemplates", wrap(() => LAUNCH_TEMPLATES));
  electron.ipcMain.handle("proxy.apply", wrap(() => syncProxyFromSettings()));
  electron.ipcMain.handle("proxy.test", wrap((opts) => testProxy(opts)));
  electron.ipcMain.handle("instance.list", wrap(() => instanceService.list()));
  electron.ipcMain.handle("instance.discover", wrap((root) => instanceService.discover(root)));
  electron.ipcMain.handle("instance.save", wrap((config) => instanceService.save({ ...config, id: config.id ? sanitizeId(config.id) : "" })));
  electron.ipcMain.handle("instance.remove", wrap((id) => instanceService.remove(sanitizeId(id))));
  electron.ipcMain.handle("instance.start", wrap((id) => instanceService.start(sanitizeId(id))));
  electron.ipcMain.handle("instance.stop", wrap((id) => instanceService.stop(sanitizeId(id))));
  electron.ipcMain.handle("instance.restart", wrap((id) => instanceService.restart(sanitizeId(id))));
  electron.ipcMain.handle("instance.forceKill", wrap((id) => instanceService.forceKill(sanitizeId(id))));
  electron.ipcMain.handle("instance.getLogs", wrap((id, limit) => instanceService.getLogs(sanitizeId(id), limit)));
  electron.ipcMain.handle("instance.clearLogs", wrap((id) => instanceService.clearLogs(sanitizeId(id))));
  electron.ipcMain.handle("instance.checkPort", wrap((port) => instanceService.checkPort(port)));
  electron.ipcMain.handle("instance.suggestPort", wrap(() => instanceService.suggestPort()));
  electron.ipcMain.handle("instance.probeEnv", wrap((id) => instanceService.probeEnv(sanitizeId(id))));
  electron.ipcMain.handle("instance.exportDiagnostics", wrap((id) => instanceService.exportDiagnostics(sanitizeId(id))));
  electron.ipcMain.handle("instance.copyDiagnostics", wrap(async (id) => {
    const path2 = await instanceService.copyDiagnostics(sanitizeId(id));
    electron.clipboard.writeText(path2);
    return path2;
  }));
  electron.ipcMain.handle("model.list", wrap(() => modelService.list()));
  electron.ipcMain.handle("model.scan", wrap((opts) => modelService.scan(opts)));
  electron.ipcMain.handle("model.delete", wrap((id, deleteFile) => modelService.remove(id, deleteFile)));
  electron.ipcMain.handle("model.move", wrap((id, destDir) => modelService.move(id, destDir)));
  electron.ipcMain.handle("model.symlink", wrap((id, destDir) => modelService.symlink(id, destDir)));
  electron.ipcMain.handle("model.rename", wrap((id, name) => modelService.rename(id, name)));
  electron.ipcMain.handle("model.tag", wrap((id, tags) => modelService.tag(id, tags)));
  electron.ipcMain.handle("model.findDuplicates", wrap(() => modelService.findDuplicates()));
  electron.ipcMain.handle("model.downloads", wrap(() => modelService.listDownloads()));
  electron.ipcMain.handle("model.download", wrap((opts) => modelService.download(opts)));
  electron.ipcMain.handle("model.pauseDownload", wrap((id) => modelService.pauseDownload(id)));
  electron.ipcMain.handle("model.resumeDownload", wrap((id) => modelService.resumeDownload(id)));
  electron.ipcMain.handle("model.cancelDownload", wrap((id) => modelService.cancelDownload(id)));
  electron.ipcMain.handle("model.storageStats", wrap(() => modelService.storageStats()));
  electron.ipcMain.handle("model.parseExtraPaths", wrap((file) => Promise.resolve().then(() => model).then((m) => m.parseExtraModelPaths(file))));
  electron.ipcMain.handle("model.fetchCivitaiMeta", wrap((id) => modelService.fetchCivitaiMeta(id)));
  electron.ipcMain.handle("model.ensureThumbs", wrap(async () => {
    const { thumbnailService } = await Promise.resolve().then(() => require("./chunks/media-B-raWoxp.js"));
    return thumbnailService.ensureAll();
  }));
  electron.ipcMain.handle("model.batchRename", wrap(async (opts) => {
    const { renameService } = await Promise.resolve().then(() => require("./chunks/media-B-raWoxp.js"));
    return renameService.batchRename(opts.ids, opts.pattern, opts.dryRun);
  }));
  electron.ipcMain.handle("node.list", wrap(() => nodePackService.list()));
  electron.ipcMain.handle("node.refresh", wrap(() => nodePackService.refresh()));
  electron.ipcMain.handle("node.registrySearch", wrap((opts) => nodePackService.registrySearch(opts)));
  electron.ipcMain.handle("node.managerChannel", wrap(() => nodePackService.managerChannelList()));
  electron.ipcMain.handle("node.install", wrap((opts) => nodePackService.install(opts)));
  electron.ipcMain.handle("node.uninstall", wrap((id) => nodePackService.uninstall(id)));
  electron.ipcMain.handle("node.update", wrap((id, version) => nodePackService.update(id, version)));
  electron.ipcMain.handle("node.toggle", wrap((id, enabled) => nodePackService.toggle(id, enabled)));
  electron.ipcMain.handle("node.lock", wrap((id, locked) => nodePackService.lock(id, locked)));
  electron.ipcMain.handle("node.checkIssues", wrap((id) => nodePackService.checkIssues(id)));
  electron.ipcMain.handle("node.conflicts", wrap(() => nodePackService.conflicts()));
  electron.ipcMain.handle("node.smokeTest", wrap((id) => nodePackService.smokeTest(id)));
  electron.ipcMain.handle("node.snapshots", wrap(() => nodePackService.snapshots()));
  electron.ipcMain.handle("node.createSnapshot", wrap((name) => nodePackService.createSnapshot(name)));
  electron.ipcMain.handle("node.deleteSnapshot", wrap((id) => nodePackService.deleteSnapshot(sanitizeId(id))));
  electron.ipcMain.handle("node.restoreSnapshot", wrap((id) => nodePackService.restoreSnapshot(sanitizeId(id))));
  electron.ipcMain.handle("workflow.list", wrap(() => workflowService.list()));
  electron.ipcMain.handle("workflow.import", wrap((path2) => workflowService.importFile(path2)));
  electron.ipcMain.handle("workflow.launch", wrap(async (path2, baseUrl) => {
    if (baseUrl) {
      if (!isSafeExternalUrl(baseUrl)) throw new Error("Blocked unsafe URL");
      await electron.shell.openExternal(baseUrl);
      return true;
    }
    if (!isSafeOpenPath(path2)) throw new Error("Blocked opening executable/script file");
    return electron.shell.openPath(path2).then((r) => r === "");
  }));
  electron.ipcMain.handle("workflow.tag", wrap((id, tags) => workflowService.tag(id, tags)));
  electron.ipcMain.handle("workflow.queue", wrap((opts) => workflowService.queue(opts)));
  electron.ipcMain.handle("workflow.parsePngMeta", wrap((path2) => workflowService.parsePngMeta(path2)));
  electron.ipcMain.handle("monitor.system", wrap(() => monitorService.systemSnapshot()));
  electron.ipcMain.handle("monitor.queue", wrap((baseUrl) => monitorService.queueSnapshot(baseUrl)));
  electron.ipcMain.handle("monitor.history", wrap((baseUrl) => monitorService.history(baseUrl)));
  electron.ipcMain.handle("monitor.connectWs", wrap((baseUrl) => monitorService.connectWs(baseUrl)));
  electron.ipcMain.handle("monitor.disconnectWs", wrap(() => {
    monitorService.disconnectWs();
    return true;
  }));
  electron.ipcMain.handle("doctor.run", wrap((instanceId) => doctorService.run(instanceId)));
  electron.ipcMain.handle("doctor.fix", wrap((instanceId, fixId) => doctorService.fix(instanceId, fixId)));
  electron.ipcMain.handle("backup.list", wrap(() => backupService.list()));
  electron.ipcMain.handle("backup.create", wrap((opts) => backupService.create(opts)));
  electron.ipcMain.handle("backup.restore", wrap((id) => backupService.restore(sanitizeId(id))));
  electron.ipcMain.handle("backup.delete", wrap((id) => backupService.delete(sanitizeId(id))));
  electron.ipcMain.handle("backup.openFolder", wrap(async (id) => {
    const folder = backupService.openFolder(sanitizeId(id));
    return electron.shell.openPath(folder).then((r) => r === "");
  }));
  electron.ipcMain.handle("env.probe", wrap((opts) => envService.probe(opts)));
  electron.ipcMain.handle("env.createVenv", wrap((req) => envService.createVenv(req)));
  electron.ipcMain.handle("env.listPythons", wrap(() => envService.listPythons()));
  electron.ipcMain.handle("env.installTorch", wrap((opts) => envService.installTorch(opts)));
  electron.ipcMain.handle("installer.detectGpu", wrap(() => installerService.detectGpu()));
  electron.ipcMain.handle("installer.preflight", wrap((opts) => installerService.preflight(opts)));
  electron.ipcMain.handle("installer.start", wrap((plan) => installerService.start(plan)));
  electron.ipcMain.handle("installer.status", wrap(() => installerService.getStatus()));
  electron.ipcMain.handle("installer.cancel", wrap(() => installerService.cancel()));
  electron.ipcMain.handle("batch.list", wrap(() => batchService.list()));
  electron.ipcMain.handle("batch.create", wrap((job) => batchService.create(job)));
  electron.ipcMain.handle("batch.start", wrap((id) => batchService.start(id)));
  electron.ipcMain.handle("batch.cancel", wrap((id) => batchService.cancel(id)));
  electron.ipcMain.handle("batch.remove", wrap((id) => batchService.remove(id)));
  electron.ipcMain.handle("output.list", wrap((opts) => outputService.list(opts)));
  electron.ipcMain.handle("output.open", wrap(async (path2) => {
    if (!isSafeOpenPath(path2)) throw new Error("Blocked opening executable/script file");
    return electron.shell.openPath(path2).then((r) => r === "");
  }));
  electron.ipcMain.handle("output.importToWorkflow", wrap(async (path2) => {
    const meta = await workflowService.parsePngMeta(path2);
    if (meta?.workflow) {
      return workflowService.importFile(path2);
    }
    return null;
  }));
  electron.ipcMain.handle("remote.list", wrap(() => remoteService.list()));
  electron.ipcMain.handle("remote.save", wrap((config) => remoteService.save(config)));
  electron.ipcMain.handle("remote.remove", wrap((id) => remoteService.remove(id)));
  electron.ipcMain.handle("remote.test", wrap((id) => remoteService.test(id)));
  electron.ipcMain.handle("remote.listStatus", wrap(() => remoteService.listStatus()));
  electron.ipcMain.handle("market.list", wrap((opts) => marketService.list(opts)));
  electron.ipcMain.handle("market.install", wrap(async (id) => {
    return nodePackService.install({ id, source: "registry" });
  }));
  electron.ipcMain.handle("shell.openExternal", wrap(async (url) => {
    if (!isSafeExternalUrl(url)) throw new Error(`Blocked unsafe URL: ${url.slice(0, 40)}`);
    await electron.shell.openExternal(url);
    return true;
  }));
  electron.ipcMain.handle("shell.openPath", wrap(async (path2) => {
    if (!isSafeOpenPath(path2)) throw new Error("Blocked opening executable/script file");
    const result = await electron.shell.openPath(path2);
    return result === "";
  }));
  electron.ipcMain.handle("shell.pickDirectory", wrap(async () => {
    const win = getWindow();
    const res = win ? await electron.dialog.showOpenDialog(win, { properties: ["openDirectory"] }) : await electron.dialog.showOpenDialog({ properties: ["openDirectory"] });
    return res.canceled ? null : res.filePaths[0];
  }));
  electron.ipcMain.handle("shell.pickFile", wrap(async (opts) => {
    const win = getWindow();
    const options = { properties: ["openFile"], filters: opts?.filters };
    const res = win ? await electron.dialog.showOpenDialog(win, options) : await electron.dialog.showOpenDialog(options);
    return res.canceled ? null : res.filePaths[0];
  }));
  electron.ipcMain.handle("shell.writeClipboard", wrap((text) => {
    electron.clipboard.writeText(text);
    return true;
  }));
  electron.ipcMain.handle("embed.open", wrap((opts) => {
    const win = getWindow();
    if (!win) return false;
    if (!isSafeEmbedUrl(opts.url)) throw new Error("Blocked unsafe embed URL");
    if (embedView) {
      win.contentView.removeChildView(embedView);
      embedView.webContents.close();
      embedView = null;
    }
    const view = new electron.WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    embedView = view;
    win.contentView.addChildView(view);
    const bounds = win.getBounds();
    view.setBounds({
      x: 240,
      y: 64,
      width: Math.max(200, bounds.width - 240),
      height: Math.max(200, bounds.height - 64)
    });
    view.webContents.setWindowOpenHandler(({ url: navUrl }) => {
      if (isSafeExternalUrl(navUrl)) void electron.shell.openExternal(navUrl);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, navUrl) => {
      if (!isSafeEmbedUrl(navUrl) && !isLocalhostUrl(navUrl)) {
        event.preventDefault();
      }
    });
    void view.webContents.loadURL(opts.url);
    return true;
  }));
  electron.ipcMain.handle("embed.resize", wrap((rect) => {
    if (!embedView) return false;
    embedView.setBounds(rect);
    return true;
  }));
  electron.ipcMain.handle("embed.close", wrap(() => {
    const win = getWindow();
    if (embedView && win) {
      win.contentView.removeChildView(embedView);
      embedView.webContents.close();
      embedView = null;
    }
    return true;
  }));
}
function broadcast(channel, payload) {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
const IPC_EVENTS = {
  instanceStatus: "event:instance-status",
  instanceLog: "event:instance-log",
  modelScanProgress: "event:model-scan-progress",
  downloadProgress: "event:download-progress",
  monitorTick: "event:monitor-tick",
  monitorWs: "event:monitor-ws",
  batchProgress: "event:batch-progress",
  installProgress: "event:install-progress"
};
let mainWindow = null;
electron.app.commandLine.appendSwitch("disable-gpu");
electron.app.commandLine.appendSwitch("disable-gpu-compositing");
electron.app.commandLine.appendSwitch("disable-software-rasterizer");
function crashLog(msg) {
  try {
    const dir = path.join(process.env.APPDATA || path.join(process.env.HOME || "", "AppData/Roaming"), "ComfyPilot", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "boot.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
  } catch {
    try {
      const dir = path.join(electron.app.getPath("userData"), "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "startup-crash.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`);
    } catch {
    }
  }
}
process.on("uncaughtException", (err) => {
  crashLog("uncaughtException: " + (err?.stack || err));
  try {
    electron.dialog.showErrorBox("ComfyPilot 启动错误", String(err?.stack || err));
  } catch {
  }
});
process.on("unhandledRejection", (err) => {
  crashLog("unhandledRejection: " + String(err));
});
function resolveAppIcon() {
  const candidates = process.platform === "win32" ? ["ComfyPilot.ico", "comfypilot-windows-256.png", "comfypilot-windows-1024.png"] : process.platform === "darwin" ? ["ComfyPilot.icns", "comfypilot-macos-512.png", "comfypilot-macos-1024.png"] : ["comfypilot-appstore-512.png", "comfypilot-appstore-1024.png", "ComfyPilot.ico"];
  const bases = [path.join(process.resourcesPath || "", "resources"), path.join(electron.app.getAppPath(), "resources"), path.join(__dirname, "../../resources")];
  for (const base of bases) {
    for (const name of candidates) {
      const p = path.join(base, name);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
      }
    }
  }
  return candidates[0];
}
function createWindow() {
  crashLog("createWindow enter");
  const iconPath = resolveAppIcon();
  crashLog("icon: " + iconPath);
  let windowIcon;
  try {
    if (iconPath && fs.existsSync(iconPath)) {
      windowIcon = electron.nativeImage.createFromPath(iconPath);
      if (windowIcon.isEmpty()) windowIcon = void 0;
    }
  } catch {
    windowIcon = void 0;
  }
  crashLog("before new BrowserWindow");
  mainWindow = new electron.BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: APP_NAME,
    backgroundColor: "#F2F6FC",
    autoHideMenuBar: true,
    icon: process.platform === "darwin" ? void 0 : windowIcon || iconPath,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    crashLog("ready-to-show");
    mainWindow?.show();
  });
  crashLog("window constructed");
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void electron.shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isLocalhostUrl(url) || url.startsWith("file:") || Boolean(process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL));
    if (!allowed) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void electron.shell.openExternal(url);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    crashLog("loadURL " + process.env.ELECTRON_RENDERER_URL);
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else if (process.env.COMFYPILOT_BOOT_PROBE === "1") {
    crashLog("probe data url");
    void mainWindow.loadURL("data:text/html,<html><body><h1>ComfyPilot</h1></body></html>").then(() => crashLog("probe ok")).catch((e) => crashLog("probe fail " + e));
  } else {
    const html = path.join(__dirname, "../renderer/index.html");
    crashLog("loadFile " + html + " exists=" + fs.existsSync(html));
    void mainWindow.loadFile(html).then(() => crashLog("loadFile ok")).catch((e) => crashLog("loadFile fail " + e));
  }
}
crashLog("module body done, registering whenReady");
electron.app.whenReady().then(async () => {
  const e2e = process.env.COMFYPILOT_E2E === "1" || process.argv.includes("--e2e-smoke");
  crashLog("whenReady start");
  crashLog("skip db for boot test");
  electron.protocol.handle("comfy-pilot", (request) => {
    const appRoot = electron.app.getAppPath();
    const raw = request.url.replace(/^comfy-pilot:/, "");
    const safePath = safeResolveUnder(appRoot, raw);
    if (!safePath) {
      return new Response("Forbidden", { status: 403 });
    }
    return electron.net.fetch("file://" + path.resolve(safePath).replace(/\\/g, "/"));
  });
  try {
    registerIpcHandlers(() => mainWindow);
    createWindow();
    syncProxyFromSettings();
    crashLog("window created");
  } catch (err) {
    crashLog("boot failed: " + (err instanceof Error ? err.stack : String(err)));
    electron.dialog.showErrorBox("ComfyPilot 启动失败", String(err instanceof Error ? err.stack : err));
  }
  if (e2e) {
    const quitE2e = () => electron.app.quit();
    setTimeout(() => {
      try {
        mainWindow?.webContents.once("did-finish-load", () => setTimeout(quitE2e, 300));
      } catch {
      }
      setTimeout(quitE2e, 2500);
    }, 150);
  }
  if (electron.app.isPackaged) {
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.checkForUpdatesAndNotify();
    } catch (err) {
      crashLog("updater skipped: " + String(err));
    }
  }
  instanceService.on("status", (info) => broadcast(IPC_EVENTS.instanceStatus, info));
  instanceService.on("log", (id, line) => broadcast(IPC_EVENTS.instanceLog, { id, line }));
  modelService.on("progress", (p) => broadcast(IPC_EVENTS.modelScanProgress, p));
  modelService.on("download", (t) => broadcast(IPC_EVENTS.downloadProgress, t));
  monitorService.on("ws", (evt) => broadcast(IPC_EVENTS.monitorWs, evt));
  batchService.on("progress", (job) => broadcast(IPC_EVENTS.batchProgress, job));
  installerService.on("progress", (p) => broadcast(IPC_EVENTS.installProgress, p));
  const timer = setInterval(() => {
    void monitorService.systemSnapshot().then((snap) => broadcast(IPC_EVENTS.monitorTick, snap));
  }, 2e3);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  electron.app.on("before-quit", () => {
    clearInterval(timer);
    monitorService.disconnectWs();
    instanceService.stopAll();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
exports.cacheDir = cacheDir;
exports.deleteModel = deleteModel;
exports.isPathInside = isPathInside;
exports.listModels = listModels;
exports.loadSettings = loadSettings;
exports.normalizePathEverySegment = normalizePathEverySegment;
exports.proxy = proxy;
exports.security = security;
exports.upsertModel = upsertModel;
