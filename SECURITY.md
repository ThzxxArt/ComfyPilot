# Security Policy

## Supported versions

| Version         | Supported                |
| --------------- | ------------------------ |
| 0.2.5           | ✅                       |
| 0.2.4 and older | ❌ (upgrade recommended) |

## Threat model

ComfyPilot treats the Electron **renderer as untrusted**. A compromised renderer, a malicious
workflow/backup, or a renderer bug must not be able to turn IPC into arbitrary code execution or
filesystem access.

Controls added in 0.2.5:

- **Path capabilities** issued by the main process (picker/discovery/installer) replace global
  path allow-lists. Grants carry a scope and expiry.
- **Instance launch closure**: new instance paths need the picker or discovery; interpreters must be
  a picked/system Python or a venv/embedded python-shaped path; launch profile directories,
  `listen`, `port` and path-valued `extraArgs` are validated; `main.py` + a ComfyUI fingerprint are
  required before spawn.
- **Downloads**: only model extensions, only known model roots/picked targets, `wx`/explicit
  overwrite semantics, optional SHA256, `.part` until verified.
- **Backups**: field whitelist, credential stripping, restore mutex, realpath workflow targets,
  scoped section validation.
- **Filesystem**: output delete/thumb and export-script roots use realpath + symlink refusal;
  shell-open blocks executable extensions and magic bytes.
- **IPC**: sender frame fail-closed, exact dev origin/path comparison (no userinfo/prefix tricks),
  zod object schemas for high-risk channels.
- **Secrets**: OS keychain when available; Linux `basic_text` is reported as plaintext, and
  settings/remote files are written `0600` on POSIX.
- **Updates**: ComfyUI archive downloads require HTTPS and a SHA256 pin/continuity check; app
  updates require a trusted GitHub publisher and no longer auto-install on quit.

## Reporting a vulnerability

Please open a private security advisory on GitHub
(<https://github.com/ThzxxArt/ComfyPilot/security/advisories/new>) instead of a public issue.
Include the version, platform, reproduction steps, and impact. You can expect an initial response
within 7 days.

## Out of scope

- A malicious local user with the same OS account (they can already run `taskkill`, edit files, or
  launch arbitrary programs).
- Unsigned installer SmartScreen warnings.
- TLS instances with self-signed certificates: 0.2.5 warns that probes do not support them.
