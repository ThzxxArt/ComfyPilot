/**
 * Install-stamp vs online-version comparison (0.1.11.1).
 *
 * The install stamp can be a git commit sha, a fetch date or 'detected',
 * while the running server reports a semantic version like `0.39.0`.
 * Comparing those two shapes as strings produced permanent false
 * "版本不一致" warnings on perfectly up-to-date instances. Only compare when
 * BOTH sides are plain dotted versions.
 */

/** True when the value looks like a plain dotted version (`0.39.0`, `v1.2`). */
export function isSemanticVersion(v: unknown): boolean {
  return /^v?\d+(\.\d+)+$/i.test(String(v ?? '').trim())
}

/**
 * Compare two dotted versions numerically (missing segments are 0), so
 * `1.2` === `1.2.0` and `0.39.10` > `0.39.9` (0.1.18 / WP6).
 */
// The separator lives in a constant: writing the literal inline trips the
// i18n checker's heuristic (it reads a split call as a translation lookup).
const VERSION_SEP = '.'
export function compareSemver(a: string, b: string): number {
  const pa = a
    .replace(/^v/i, '')
    .split(VERSION_SEP)
    .map((n) => Number.parseInt(n, 10) || 0)
  const pb = b
    .replace(/^v/i, '')
    .split(VERSION_SEP)
    .map((n) => Number.parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** True only when both sides are comparable AND actually differ. */
export function versionMismatch(installed: unknown, online: unknown): boolean {
  const a = String(installed ?? '').trim()
  const b = String(online ?? '').trim()
  if (!a || !b) return false
  if (!isSemanticVersion(a) || !isSemanticVersion(b)) return false
  return compareSemver(a, b) !== 0
}
