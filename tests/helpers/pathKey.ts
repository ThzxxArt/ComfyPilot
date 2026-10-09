/**
 * Cross-platform key normalizer for in-memory fs mocks.
 *
 * On POSIX, `path.resolve('C:/fake/ComfyUI')` returns
 * `'<cwd>/C:/fake/ComfyUI'` (a Windows drive path is treated as relative).
 * Test fixtures use `C:/...` literals, so mock lookups must strip any cwd
 * prefix that `resolve()` prepended — otherwise every existsSync check
 * misses and the suite fails on Linux CI while passing on Windows.
 */
export function pathKey(p: unknown): string {
  let s = String(p ?? '').replace(/\\/g, '/')
  // Pull out a Windows-drive segment wherever it appears (start or after a cwd).
  const m = s.match(/([A-Za-z]:\/.*)$/)
  if (m) return m[1].replace(/\/+/g, '/')
  return s.replace(/\/+/g, '/')
}
