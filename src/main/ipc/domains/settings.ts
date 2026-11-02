import type { AppSettings } from '@shared/types'
import { LAUNCH_TEMPLATES } from '@shared/constants'
import {
  clearProxyPassword,
  getDataMigrationState,
  retryDataMigration,
  loadSettings,
  saveSettings,
  setProxyPassword
} from '../../services/db'
import { secretStorageBackend } from '../../services/secretStorage'
import { syncProxyFromSettings, testProxy } from '../../services/proxy'
import { assertSafeSettingsPatch } from '../../services/security'
import {
  assertApprovedExecutable,
  assertSafeEndpointSettings,
  settingsView,
  wrap
} from '../context'

export function createSettingsHandlers() {
  return {
    migrationState: wrap(() => getDataMigrationState()),
    retryMigration: wrap(() => retryDataMigration()),

    get: wrap(() => settingsView(loadSettings())),
    setProxyPassword: wrap((password: string) => {
      if (typeof password !== 'string' || /[\r\n\0]/.test(password)) {
        throw new Error('Invalid proxy password')
      }
      setProxyPassword(password)
      syncProxyFromSettings()
      return { ok: true }
    }),
    clearProxyPassword: wrap(() => {
      clearProxyPassword()
      syncProxyFromSettings()
      return { ok: true }
    }),
    exportConfig: wrap(async () => {
      const s = loadSettings()
      // Never export secrets. The proxy password is the only one stored here.
      const { proxy, ...rest } = s
      return {
        version: 2,
        schemaVersion: 2,
        exportedAt: Date.now(),
        settings: {
          ...rest,
          proxy: { ...proxy, password: '' }
        }
      }
    }),
    importConfig: wrap(async (raw: Record<string, unknown>) => {
      const { assertSafeSettingsPatch, stripImportedSettingsSecrets } =
        await import('../../services/security')
      const incoming =
        raw && typeof raw === 'object' && 'settings' in raw
          ? ((raw as { settings?: unknown }).settings as Record<string, unknown>)
          : raw
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new Error('Invalid settings file')
      }
      // A config file must never carry (or overwrite) credentials. Removing
      // the key keeps the stored ciphertext; setting it to '' WIPED it.
      const { patch } = stripImportedSettingsSecrets(incoming)
      assertSafeSettingsPatch(patch)
      const before = loadSettings() as unknown as Record<string, unknown>
      const next = saveSettings(patch as Partial<AppSettings>)
      // 0.1.18 (regression): an import persisted the proxy/locale/autostart but
      // never applied them — the UI said "on" while Electron still went direct.
      syncProxyFromSettings()
      if (patch.launchOnBoot !== undefined) {
        try {
          const { setLaunchOnBoot } = await import('../../services/desktop')
          setLaunchOnBoot(Boolean(next.launchOnBoot))
        } catch {
          /* ignore */
        }
      }
      if (patch.locale !== undefined) {
        try {
          const { refreshTray } = await import('../../services/tray')
          void refreshTray()
        } catch {
          /* ignore */
        }
      }
      // Report only keys that really changed (unknown keys are stripped by
      // saveSettings, and an identical value is not "applied").
      const after = next as unknown as Record<string, unknown>
      const applied = Object.keys(patch).filter(
        (k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])
      )
      const warnings: string[] = []
      for (const key of [
        'securityLevel',
        'allowGitUrlInstall',
        'allowPipInstall',
        'allowUnverifiedRuntime'
      ]) {
        if (key in incoming) warnings.push(`${key} is local security state and was ignored`)
      }
      if (
        incoming.proxy &&
        typeof incoming.proxy === 'object' &&
        'password' in (incoming.proxy as Record<string, unknown>)
      ) {
        warnings.push('proxy.password was ignored — credentials never travel in a config file')
      }
      return { settings: settingsView(next), applied, warnings }
    }),
    credentialStatus: wrap(async () => {
      const db = await import('../../services/db')
      return {
        proxyPasswordUnreadable: db.isProxyPasswordUnreadable(),
        proxyCredentialBackend: secretStorageBackend(),
        lockedRemoteIds: db
          .listRemotes()
          .filter((r) => r.apiKeyLocked)
          .map((r) => r.id)
      }
    }),
    set: wrap(async (patch: Partial<AppSettings>) => {
      // 0.1.17 (WP8): endpoint-shaped settings flow straight into installers and
      // network probes. Accepting `file:`/`javascript:`/garbage there turned a
      // settings write into a local-file or scheme-injection primitive.
      // 0.1.18 (WP1): every attacker-reachable value is validated, not just the
      // five URLs — an unknown `securityLevel` used to weaken the install gate.
      assertSafeEndpointSettings(patch)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('settings.set expects an object patch')
      }
      assertSafeSettingsPatch(patch as Record<string, unknown>)
      if (patch.aria2Path) assertApprovedExecutable(String(patch.aria2Path), 'aria2Path')
      if (
        patch.securityLevel !== undefined &&
        patch.securityLevel !== loadSettings().securityLevel
      ) {
        console.warn(
          `[security] securityLevel changed to ${String(patch.securityLevel)} by renderer`
        )
      }
      const next = saveSettings(patch)
      // Re-apply proxy whenever settings change
      syncProxyFromSettings()
      // Keep OS login item in sync with the persisted preference
      if (patch.launchOnBoot !== undefined) {
        try {
          const { setLaunchOnBoot } = await import('../../services/desktop')
          setLaunchOnBoot(Boolean(next.launchOnBoot))
        } catch {
          /* ignore */
        }
      }
      // Language switch must re-render the native tray menu.
      if (patch.locale !== undefined) {
        try {
          const { refreshTray } = await import('../../services/tray')
          void refreshTray()
        } catch {
          /* ignore */
        }
      }
      return settingsView(next)
    }),
    launchTemplates: wrap(() => LAUNCH_TEMPLATES),
    dataDir: wrap(async () => {
      const { userDataDir } = await import('../../services/db')
      return userDataDir()
    }),
    logsDir: wrap(async () => {
      const { logsDir } = await import('../../services/db')
      return logsDir()
    }),

    applyProxy: wrap(() => syncProxyFromSettings()),
    testProxy: wrap((opts?: { url?: string }) => testProxy(opts))
  }
}
