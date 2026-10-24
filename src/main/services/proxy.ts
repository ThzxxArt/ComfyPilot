import { session } from 'electron'
import type { ProxySettings } from '@shared/types'
import { loadSettings } from './db'
import { isSafeExternalUrl } from './security'

/** Build a proxy URL for child-process env (may include credentials). */
export function buildProxyUrl(p: ProxySettings, opts?: { withAuth?: boolean }): string {
  if (!p.enabled || !p.host || !p.port) return ''
  assertSafeProxyHost(p.host)
  assertSafeProxyPort(p.port)
  const withAuth = opts?.withAuth !== false
  const auth =
    withAuth && p.username
      ? `${encodeURIComponent(p.username)}${
          p.password ? ':' + encodeURIComponent(p.password) : ''
        }@`
      : ''
  const proto = p.protocol === 'socks5' ? 'socks5' : p.protocol === 'https' ? 'https' : 'http'
  return `${proto}://${auth}${p.host}:${p.port}`
}

/** Redacted URL safe for UI / logs / IPC results. */
export function redactProxyUrl(p: ProxySettings): string {
  return buildProxyUrl(p, { withAuth: false })
}

export function buildBypassList(p: ProxySettings): string {
  const extra = String(p.bypass || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  // Bare loopback forms only (0.1.16). The old list injected `[::1]` with
  // brackets, which breaks naive `no_proxy` parsers in third-party nodes
  // (they split on ':' and read the port as ":1]") — the observed
  // `GoogleTranslateNode -> Invalid port ':1]'`. Chromium and Python both
  // accept the unbracketed `::1`. Leading dots are stripped so entries match
  // the same normalized form used by `shouldBypass`.
  const entries = ['localhost', '127.0.0.1', '::1', ...extra].map((h) =>
    normalizeHost(h.replace(/^\.+/, ''))
  )
  return [...new Set(entries)].join(';')
}

function normalizeHost(host: string): string {
  return String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
}

export function shouldBypass(url: string, bypassList: string): boolean {
  try {
    const u = new URL(url)
    const host = normalizeHost(u.hostname)
    const list = bypassList
      .split(/[;\s,]+/)
      .map((s) => normalizeHost(s.trim().replace(/^\./, '')))
      .filter(Boolean)
    return list.some((b) => {
      if (host === b) return true
      // suffix match only for multi-label bypass entries (avoid `com` matching evil.com)
      if (!b.includes('.')) return false
      return host.endsWith('.' + b)
    })
  } catch {
    return false
  }
}

/**
 * Build env vars for child processes (git / pip / uv / aria2).
 * Never mutates process.env.
 */
export function proxyEnv(
  p: ProxySettings,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const base = { ...baseEnv }
  delete base.HTTP_PROXY
  delete base.HTTPS_PROXY
  delete base.ALL_PROXY
  delete base.http_proxy
  delete base.https_proxy
  delete base.all_proxy
  delete base.NO_PROXY
  delete base.no_proxy
  if (!p.enabled) return base
  let url = ''
  try {
    url = buildProxyUrl(p)
  } catch {
    // Invalid proxy config must never poison child-process env.
    return base
  }
  if (!url) return base
  base.HTTP_PROXY = url
  base.HTTPS_PROXY = url
  base.http_proxy = url
  base.https_proxy = url
  if (p.protocol === 'socks5') {
    base.ALL_PROXY = url
    base.all_proxy = url
  }
  const bypass = buildBypassList(p).replace(/;/g, ',')
  base.NO_PROXY = bypass
  base.no_proxy = bypass
  return base
}

/** Validate proxy host so it cannot inject proxyRules separators. */
export function assertSafeProxyHost(host: string): string {
  const h = String(host || '').trim()
  if (!h) throw new Error('Proxy host is empty')
  if (/[;@\s\\/]/.test(h)) throw new Error('Proxy host contains illegal characters')
  return h
}

export function assertSafeProxyPort(port: number): number {
  const n = Number(port)
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid proxy port')
  return n
}

/** Apply proxy to Electron default session. URL is redacted in the return value. */
export function applyProxyToElectron(p: ProxySettings): {
  enabled: boolean
  url: string
  bypass: string
} {
  const bypass = buildBypassList(p)
  const ses = session.defaultSession
  if (!p.enabled || !p.host || !p.port) {
    void ses.setProxy({ mode: 'direct' }).catch(() => {})
    return { enabled: false, url: '', bypass }
  }
  assertSafeProxyHost(p.host)
  assertSafeProxyPort(p.port)
  // Chromium proxyRules: no credentials; use socks: for socks5. Normalise the
  // scheme exactly like buildProxyUrl — a legacy config with no protocol used
  // to produce "undefined://host:port" and silently disabled the proxy.
  const proto = p.protocol === 'socks5' ? 'socks' : p.protocol === 'https' ? 'https' : 'http'
  const rules = `${proto}://${p.host}:${p.port}`
  void ses
    .setProxy({
      mode: 'fixed_servers',
      proxyRules: rules,
      proxyBypassRules: bypass
    })
    .catch(() => {})
  return { enabled: true, url: redactProxyUrl(p), bypass }
}

/**
 * 0.1.18 (WP1 / S2): decide whether a Chromium login challenge is OUR proxy's.
 *
 * `setProxy` cannot carry credentials, so an authenticated proxy used to fail
 * every request with 407 ("network unreachable"). Returns null for site logins
 * (those must never receive the proxy password) and when no user is configured.
 */
export function proxyAuthFor(
  authInfo: { isProxy?: boolean } | undefined,
  settings: { proxy: ProxySettings }
): { username: string; password: string } | null {
  if (!authInfo?.isProxy) return null
  const p = settings?.proxy
  if (!p?.enabled || !p.username) return null
  return { username: p.username, password: p.password || '' }
}

/** Fetch via Electron session (honours session proxy). Does not leak proxy secrets. */
export async function fetchThroughProxy(
  url: string,
  opts?: { method?: string }
): Promise<Response> {
  if (!isSafeExternalUrl(url)) throw new Error('Blocked unsafe URL for proxy test')
  return session.defaultSession.fetch(url, {
    method: opts?.method || 'GET',
    signal: AbortSignal.timeout(10000)
  }) as unknown as Promise<Response>
}

/**
 * Proxy-aware HTTP fetch for EXTERNAL requests.
 *
 * This is the one entry point every outbound network call should use.
 * `session.defaultSession.fetch` routes through the Electron session proxy
 * (set by applyProxyToElectron), while Node's global `fetch` does NOT —
 * which is how "I configured a proxy but downloads still time out" happens.
 *
 * Localhost probes (ComfyUI health, /system_stats) must keep using plain
 * fetch so they bypass the proxy by design.
 */
export async function proxyFetch(
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<Response> {
  // Same URL safety gate as fetchThroughProxy — never fetch arbitrary schemes.
  if (!isSafeExternalUrl(url)) throw new Error(`Blocked unsafe URL: ${url.slice(0, 60)}`)
  return session.defaultSession.fetch(url, {
    method: init?.method || 'GET',
    headers: init?.headers,
    body: init?.body as never,
    signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? 30000)
  }) as unknown as Promise<Response>
}

export async function testProxy(opts?: {
  url?: string
}): Promise<{ ok: boolean; via: string; ms: number; error?: string }> {
  const settings = loadSettings()
  const p = settings.proxy
  const target = opts?.url || 'https://www.gstatic.com/generate_204'
  const started = Date.now()
  const via = p.enabled ? redactProxyUrl(p) : 'direct'
  try {
    applyProxyToElectron(p)
    const res = await fetchThroughProxy(target)
    return {
      ok: res.ok || res.status === 204 || res.status === 302,
      via,
      ms: Date.now() - started
    }
  } catch (e) {
    return {
      ok: false,
      via,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export function syncProxyFromSettings(): { enabled: boolean; url: string; bypass: string } {
  try {
    return applyProxyToElectron(loadSettings().proxy)
  } catch {
    // On invalid config, explicitly fall back to direct so we never
    // claim "direct" while a stale proxy remains active.
    try {
      void session.defaultSession.setProxy({ mode: 'direct' }).catch(() => {})
    } catch {
      /* ignore */
    }
    return { enabled: false, url: '', bypass: '' }
  }
}
