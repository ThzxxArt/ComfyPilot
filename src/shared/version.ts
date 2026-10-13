/**
 * Shared version comparison for node packs (and any dotted-version needs).
 * Moved out of nodePack.ts in 0.1.11 so the renderer can judge "is this really
 * an update" with the SAME rules as the main process — the old UI fallback
 * only checked "!==, both numeric", which lit an update badge for a LOWER
 * latestVersion (1.0 vs local 1.2).
 */

/**
 * Minimal version comparator for node packs.
 * - numeric dotted versions (1.2.3, 1.2.3.4) compare segment-wise
 * - pre-release suffix (1.2.3-beta) sorts before plain 1.2.3
 * - non-semver strings fall back to localeCompare (equality still works)
 * Returns >0 when a > b, <0 when a < b, 0 when equal/incomparable-as-equal.
 */
export function compareVersions(a: string, b: string): number {
  const na = String(a || '').trim()
  const nb = String(b || '').trim()
  if (!na && !nb) return 0
  if (!na) return -1
  if (!nb) return 1
  if (na === nb) return 0

  const parse = (v: string): { nums: number[]; pre: string } => {
    const m = v.match(/^v?(\d+(?:\.\d+)*)(?:[-+.]?(.*))?$/i)
    if (!m) return { nums: [], pre: v.toLowerCase() }
    const nums = m[1].split('.').map((s) => Number(s) || 0)
    return { nums, pre: (m[2] || '').toLowerCase() }
  }
  const A = parse(na)
  const B = parse(nb)
  if (A.nums.length && B.nums.length) {
    const len = Math.max(A.nums.length, B.nums.length)
    for (let i = 0; i < len; i++) {
      const x = A.nums[i] ?? 0
      const y = B.nums[i] ?? 0
      if (x !== y) return x - y
    }
    // same numeric core: a release (no pre) > a pre-release
    if (A.pre && !B.pre) return -1
    if (!A.pre && B.pre) return 1
    return A.pre.localeCompare(B.pre)
  }
  return na.localeCompare(nb)
}

/** True when `latest` is strictly newer than `current`. */
export function isUpdateAvailable(current: string, latest: string): boolean {
  if (!current || !latest) return false
  // Non-comparable free-form strings: treat any difference as "unknown", not an update.
  const looksNumeric = (v: string): boolean => /^v?\d/i.test(v.trim())
  if (!looksNumeric(current) || !looksNumeric(latest)) {
    // commit shas: different means "maybe", but we only flag when latest is a
    // clearly longer/different git describe — keep conservative (no update flag).
    return false
  }
  return compareVersions(latest, current) > 0
}
