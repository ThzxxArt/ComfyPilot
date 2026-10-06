import { session, app } from 'electron'
import type { ProxySettings } from '@shared/types'
import { loadSettings } from './db'

/** Build a proxy URL for fetch / undici / curl-style tools. */
export function buildProxyUrl(p: ProxySettings): string {
  if (!p.enabled || !p.host || !p.port) return ''
  const auth =
    p.username && p.password
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
      : p.username
        ? `${encodeURIComponent(p.username)}@`
        : ''
  const proto = p.protocol === 'socks5' ? 'socks5' : p.protocol === 'https' ? 'https' : 'http'
  return `${proto}://${auth}${p.host}:${p.port}`
}

export function buildBypassList(p: ProxySettings): string {
  const extra = String(p.bypass || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set(['localhost', '127.0.0.1', '::1', ...extra])].join(';')
}

export function shouldBypass(url: string, bypassList: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const list = bypassList
      .split(/[;\s,]+/)
      .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)
    return list.some((b) => host === b || host.endsWith('.' + b))
  } catch {
    return false
  }
}

/**
 * Build env vars for child processes (git / pip / uv / aria2).
 * Includes standard HTTP(S)_PROXY plus ALL_PROXY for socks.
 */
export function proxyEnv(p: ProxySettings): NodeJS.ProcessEnv {
  const base = { ...process.env }
  if (!p.enabled) {
    delete base.HTTP_PROXY
    delete base.HTTPS_PROXY
    delete base.ALL_PROXY
    delete base.http_proxy
    delete base.https_proxy
    delete base.all_proxy
    return base
  }
  const url = buildProxyUrl(p)
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

/** Apply proxy to Electron default session (renderer / webRequest). */
export function applyProxyToElectron(p: ProxySettings): { enabled: boolean; url: string; bypass: string } {
  const url = buildProxyUrl(p)
  const bypass = buildBypassList(p)
  const ses = session.defaultSession
  if (!p.enabled || !url) {
    void ses.setProxy({ mode: 'direct' })
    return { enabled: false, url: '', bypass }
  }
  void ses.setProxy({
    mode: 'fixed_servers',
    proxyRules: url.replace(/^socks5:/, 'socks:'),
    proxyBypassRules: bypass
  })
  return { enabled: true, url, bypass }
}

export async function testProxy(
  opts?: { url?: string }
): Promise<{ ok: boolean; via: string; ms: number; error?: string }> {
  const settings = loadSettings()
  const p = settings.proxy
  const target = opts?.url || 'https://www.gstatic.com/generate_204'
  const started = Date.now()
  try {
    // Node fetch uses NO_PROXY/HTTP_PROXY from env in undici? Electron main
    // process net.fetch honors session proxy; use session fetch after apply.
    applyProxyToElectron(p)
    const res = await session.defaultSession.fetch(target, {
      method: 'GET',
      signal: AbortSignal.timeout(8000)
    })
    return {
      ok: res.ok || res.status === 204 || res.status === 302,
      via: p.enabled ? buildProxyUrl(p) : 'direct',
      ms: Date.now() - started
    }
  } catch (e) {
    return {
      ok: false,
      via: p.enabled ? buildProxyUrl(p) : 'direct',
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** Load + apply on app ready / settings save. */
export function syncProxyFromSettings(): { enabled: boolean; url: string; bypass: string } {
  try {
    return applyProxyToElectron(loadSettings().proxy)
  } catch {
    return { enabled: false, url: '', bypass: '' }
  }
}

void app
