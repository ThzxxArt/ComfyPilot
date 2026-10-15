/**
 * Frontend-package version alignment (0.1.15).
 *
 * ComfyUI reports the installed `comfyui-frontend-package` version and the
 * version it REQUIRES via /system_stats (`comfy_package_versions`). A source
 * update can leave the venv one or more frontend bumps behind — these helpers
 * derive the status badge facts and the one-click align spec
 * (`comfyui-frontend-package==<required>`), and stay silent when no action
 * applies (both versions equal / either side missing).
 */

export interface FrontendPkgStatus {
  installed: string
  required: string
  mismatch: boolean
}

/**
 * Extract the frontend-package status from a capabilities payload.
 * `requiredFrontendVersion` is the server-level fallback for builds whose
 * package entry omits the required field. Returns null when neither side
 * reports anything (old servers) — the UI then shows no badge at all.
 */
export function frontendPkgStatus(
  packages: Array<{ name: string; installed: string; required: string }>,
  requiredFrontendVersion?: string
): FrontendPkgStatus | null {
  const pkg = packages.find((p) => p.name === 'comfyui-frontend-package')
  const installed = pkg?.installed || ''
  const required = pkg?.required || requiredFrontendVersion || ''
  if (!installed && !required) return null
  return {
    installed: installed || '—',
    required: required || '—',
    mismatch: Boolean(installed && required && installed !== required)
  }
}

/**
 * Align spec for a mismatching frontend package: `comfyui-frontend-package==X`.
 * Returns null when there is nothing to do (equal / missing values) or when
 * the required token is not a plain version-ish string (the pip-spec gate in
 * main stays the backstop, but we never construct a clearly-invalid spec).
 */
export function frontendAlignSpec(installed: string, required: string): string | null {
  const a = String(installed || '').trim()
  const b = String(required || '').trim()
  if (!a || !b || a === b) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(b)) return null
  return `comfyui-frontend-package==${b}`
}
