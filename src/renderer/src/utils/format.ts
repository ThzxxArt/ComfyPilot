/** Percentage helpers — UI must never print raw floats like 14.285714285714286. */

export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}

/** Text form for a percentage. Default integer; digits>0 keeps at most that many decimals. */
export function formatPercent(n: number, digits = 0): string {
  const raw = Number.isFinite(n) ? n : 0
  const clamped = Math.min(100, Math.max(0, raw))
  return digits > 0 ? `${clamped.toFixed(digits)}%` : `${Math.round(clamped)}%`
}

export function formatBytes(n: number): string {
  if (!n) return '0 B'
  // Non-finite / negative inputs used to print `Infinity TB` / `-2048 B`
  // (0.1.11 border cleanup): firmware values and delta displays hit this.
  if (!Number.isFinite(n)) return '—'
  const neg = n < 0
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Math.abs(n)
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  // 0 decimals ≥10 units, 1 decimal for small KB/MB — never a long tail.
  // Rounding first then re-promoting avoids "1024 B" for 1023.6 bytes.
  let digits = v >= 10 || i === 0 ? 0 : 1
  let text = v.toFixed(digits)
  if (Number(text) >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
    digits = v >= 10 || i === 0 ? 0 : 1
    text = v.toFixed(digits)
  }
  return `${neg ? '-' : ''}${text} ${u[i]}`
}

/** Human uptime from milliseconds: 3h 12m / 5m 3s / 42s */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Transfer speed label. */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

/** ISO timestamp → local short date ('' — for absent/unparseable input). */
/**
 * 0.1.18 (WP6): the UI language decides the date format. Falling back to the
 * OS locale produced mixed-language dates (e.g. English UI, Chinese dates).
 */
export function formatDate(iso?: string, locale?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  try {
    return d.toLocaleDateString(locale || undefined)
  } catch {
    return d.toLocaleDateString()
  }
}
