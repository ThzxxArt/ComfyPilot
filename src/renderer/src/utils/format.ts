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
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  // 0 decimals ≥10 units, 1 decimal for small KB/MB — never a long tail
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
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
