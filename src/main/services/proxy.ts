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
  return [...new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...extra])].join(';')
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
export function proxyEnv(p: ProxySettings): NodeJS.ProcessEnv {
  const base = { ...process.env }
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
  // Chromium proxyRules: no credentials; use socks: for socks5
  const rules = `${p.protocol === 'socks5' ? 'socks' : p.protocol}://${p.host}:${p.port}`
  void ses
    .setProxy({
      mode: 'fixed_servers',
      proxyRules: rules,
      proxyBypassRules: bypass
    })
    .catch(() => {})
  return { enabled: true, url: redactProxyUrl(p), bypass }
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
