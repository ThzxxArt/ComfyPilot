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

/** True only when both sides are comparable AND actually differ. */
export function versionMismatch(installed: unknown, online: unknown): boolean {
  const a = String(installed ?? '').trim()
  const b = String(online ?? '').trim()
  if (!a || !b) return false
  if (!isSemanticVersion(a) || !isSemanticVersion(b)) return false
  return a.replace(/^v/i, '') !== b.replace(/^v/i, '')
}
