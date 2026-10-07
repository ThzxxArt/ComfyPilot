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
