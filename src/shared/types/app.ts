/** Shared app-level types: locale, updates, issues, proxy, settings, notifications. */
import type { RemoteInstanceConfig } from './batch'

// ---------- App ----------
export type AppLocale = 'zh-CN' | 'en-US'

/** Manual app self-update check (0.1.11 — makes the auto-update channel visible). */
export interface AppUpdateStatus {
  /** unsupported = dev build / updater unavailable. */
  status:
    | 'unsupported'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'not-available'
    | 'error'
  currentVersion: string
  /** Version offered by the update server, when available. */
  availableVersion?: string
  /** Live download progress (present while `downloading`, 0.1.13). */
  progress?: {
    percent: number
    bytesPerSecond?: number
    transferred?: number
    total?: number
  }
  error?: string
  checkedAt: number
}

/**
 * Previous-session exit facts (0.1.16).
 * Written to `<logsDir>/session.json` on start / clean exit so the next launch
 * can tell the user "last run did not exit cleanly" and offer a diagnostics
 * export — the app previously had no way to prove how it had ended.
 */
export interface PreviousExitInfo {
  /** True when the previous session wrote a clean-exit marker. */
  clean: boolean
  /** Epoch ms of the previous session's start (null on first run). */
  startedAt: number | null
  /** Epoch ms of the clean exit (null when the session ended uncleanly). */
  endedAt: number | null
  /** Optional last recorded reason (e.g. an uncaught-exception summary). */
  detail?: string
}

/** A single custom-node pack that failed to import at boot (0.1.16). */
export type AppIssueKind = 'startup' | 'node-load' | 'deps' | 'doctor' | 'exec'
export type AppIssueStatus = 'open' | 'acknowledged' | 'resolved' | 'ignored'

export interface AppIssueAction {
  id: string
  labelKey: string
  kind: 'navigate' | 'ipc'
  /** Route for navigate, IPC channel for ipc. */
  target: string
  params?: Record<string, unknown>
}

/** One actionable problem, persisted in issues.jsonc (0.2.0 IssueCenter). */
export interface AppIssue {
  id: string
  fingerprint: string
  kind: AppIssueKind
  instanceId?: string
  pack?: string
  module?: string
  severity: 'error' | 'warning' | 'info'
  title: string
  detail: string
  actions: AppIssueAction[]
  status: AppIssueStatus
  firstSeen: number
  lastSeen: number
  updatedAt: number
}

export interface InstanceStartupIssue {
  /** Custom-node pack folder name, or 'unknown'. */
  pack: string
  /** Human-readable failure summary (verbatim from the log, trimmed). */
  summary: string
  /** Missing import names parsed from the log (best effort, may be empty). */
  missingModules: string[]
  /**
   * 0.2.0: platform/accelerator-optional imports (torch_npu, OpenGL_accelerate).
   * They never make an otherwise healthy pack fail.
   */
  optionalModules?: string[]
}

/** Startup issues surfaced after an instance boots (0.1.16). */
export interface InstanceStartupIssues {
  instanceId: string
  /** 0.2.0: boot marker id used to scope the scan; absent for legacy logs. */
  bootId?: string
  /** True when at least one pack failed to import. */
  hasIssues: boolean
  issues: InstanceStartupIssue[]
  scannedAt: number
}

export type ProxyProtocol = 'http' | 'https' | 'socks5'

export interface ProxySettings {
  enabled: boolean
  protocol: ProxyProtocol
  host: string
  port: number
  username: string
  password: string
  /** Comma/space separated hosts that bypass proxy (localhost always bypassed) */
  bypass: string
  /**
   * 0.2.0: endpoint the stored password belongs to. Changing
   * protocol/host/port/username invalidates the credential instead of silently
   * reusing it against a new endpoint.
   */
  credentialOrigin?: string
}

/** Renderer-safe proxy view — the password never crosses IPC. */
export interface ProxySettingsView extends Omit<ProxySettings, 'password'> {
  hasPassword: boolean
  backend: 'os-keychain' | 'plaintext' | 'unavailable'
}

export interface RemoteInstanceSummary extends Omit<RemoteInstanceConfig, 'apiKey'> {
  apiKeySet: boolean
}

/** Renderer-safe settings: the proxy password never crosses IPC. */
export interface AppSettingsView extends Omit<AppSettings, 'proxy'> {
  proxy: ProxySettingsView
}

export interface AppSettings {
  locale: AppLocale
  modelScanRoots: string[]
  githubEndpoint: string
  hfEndpoint: string
  civitaiEndpoint: string
  enableAutoCheckUpdates: boolean
  embedFrontend: boolean
  securityLevel: 'strong' | 'normal' | 'normal-' | 'weak'
  allowGitUrlInstall: boolean
  allowPipInstall: boolean
  networkMode: 'public' | 'private' | 'offline' | 'personal_cloud'
  aria2Path: string
  useAria2: boolean
  /** Start ComfyPilot at OS login */
  launchOnBoot: boolean
  /** Closing the window hides to tray instead of quitting */
  minimizeToTray: boolean
  /** On app ready, start every instance whose autoStart is true */
  autoStartInstancesOnLaunch: boolean
  proxy: ProxySettings
  /** PyPI index URL for pip/uv installs (empty = official). e.g. https://pypi.tuna.tsinghua.edu.cn/simple */
  pipIndex: string
  /** Optional torch wheel index override (empty = download.pytorch.org per channel) */
  torchIndexMirror: string
  /** Output-library scan depth under the output root (0.1.9, default 4, 2..10). */
  outputScanDepth: number
  /**
   * Stop strategy (0.1.18). `fast` (default) terminates the tree immediately;
   * `graceful` asks the tree to close and waits up to 3 s first. Node cannot
   * send CTRL_BREAK, and `taskkill /T` without /F is a no-op for console
   * Python — the old "graceful" default always burned the full 3 s.
   */
  stopMode?: 'fast' | 'graceful'
  /**
   * 0.1.18 (WP1 / S3): downloading a runtime with no published checksum and no
   * prior pin is refused unless the user explicitly opts in here. TOFU used to
   * trust (and permanently pin) whatever the first download produced.
   */
  allowUnverifiedRuntime?: boolean
}

// ---------- Notifications ----------
export interface NotificationAction {
  /** A renderer route or a known issue action id. */
  type: 'navigate' | 'issue' | 'none'
  target?: string
  labelKey?: string
  params?: Record<string, string | number>
}

export interface AppNotification {
  /** Stable id — toasts are consumed by id, never by sequence arithmetic. */
  id: string
  /** Creation timestamp (ms). */
  at: number
  /** Persistent read marker; unread = items without readAt. */
  readAt?: number
  /** Optional 10s dedupe key (batch updates emit one summary). */
  dedupeKey?: string
  action?: NotificationAction
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  duration?: number
  /** i18n key for the title — renderer translates when present (title is fallback). */
  titleKey?: string
  /** i18n key for the message — renderer translates when present (message is fallback). */
  messageKey?: string
  /** Interpolation params for titleKey / messageKey. */
  params?: Record<string, string | number>
}

/** Caller-facing shape: the store fills id/at. */
export type AppNotificationInput = Omit<AppNotification, 'id' | 'at' | 'readAt'> &
  Partial<Pick<AppNotification, 'id' | 'at' | 'readAt'>>
