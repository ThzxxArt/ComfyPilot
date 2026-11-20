# Changelog

## 0.2.5 — 2026-11-20

> Runtime truth, stuck-instance rescue, and upstream alignment.
> **No data migration:** `schemaVersion` remains 2 and 0.2.4 data loads as-is.

### Added

- Evidence-based instance health (`healthy / busy / suspect / unresponsive / crashed / stopped`),
  health badges, `logs/health.log`, `instanceHealth` events and diagnostics evidence.
- Lock-screen rescue commands: `--rescue`, `--safe-rescue`, `--stop`, `--start`, `--status`,
  plus a generated rescue `.bat`.
- Safe mode: a one-run `--disable-all-custom-nodes` flag with a banner and exit action.
- Optional automatic recovery (off by default, managed local instances only, attempts capped).
- Effective launch resolution from the final argv: last `--port` / `--listen` / directory flags win,
  including comma-separated listen lists and Windows paths.
- ComfyUI-Manager 4.4 facts: `user/__manager/config.ini`, pip/git detection, security/network mode,
  snapshots, legacy backup, atomic backed-up writes.
- Stable/nightly update channels; stable uses GitHub release tag archives; updates verify by a real
  `--quick-test-for-ci --cpu` startup self-check and roll back the source on failure.
- Node version rollback v1: exact git checkout, best-effort registry reinstall, local-pack warnings.
- CUDA 13 (`cu130`) default, `cu126` compatibility, ROCm 7.2 (Linux), ROCm 10.0 (Windows), XPU/MPS/CPU.
- `PathCapability` grants, model download extension/target policy, ComfyUI fingerprint before spawn,
  backup field whitelist and restore mutex, symlink-root refusal, realpath output containment.
- Civitai filename resolution (Content-Disposition → API files → safe extension) and metadata;
  `.part` downloads; queue-aware batch deadlines; scoped backup restore; ghost output pruning.
- Doctor now reports Manager version/source, real `config.ini`, security/network mode, legacy
  backup and ComfyPilot-vs-Manager policy mismatches; the instance card offers an explicit,
  confirmed pip install of Manager 4.4.2 that reuses the mirror/proxy pipeline.
- The last selected local target is persisted (`activeInstance`), so a restart no longer redirects
  destructive work to the first registered instance.

### Changed

- New instances default to `stable`; existing master-tracking instances stay `nightly` with a prompt.
- `ComfyPilot install policy` is no longer labelled as Manager's `security_level`.
- Python wording: 3.13 remains the validated default, 3.12 is the official fallback, 3.14 has
  custom-node compatibility risk but no longer claims “no torch wheels”.
- Release gate now builds, runs Linux xvfb E2E, starts the packaged `--dir` Windows app, and checks
  the real `app.asar`. Windows CI also enforces coverage.

### Fixed

- Installer run isolation, abortable/checksum-pinned ComfyUI zip, venv archive-before-recreate,
  truthful Python version reporting, env lock coverage, spawn-after-stop orphans, owned adoption.
- Port-conflict save no longer drops `pythonVersion` / `migrationState` / `migrationError`
  (`instance.patch` / `instance.setPort`), and a whole-record save preserves fields the caller
  did not know about.
- Manager v4 list schema (`{custom_nodes:[...]}`), v4-first merge, ETag/cache/offline fallback.
- TaskCenter reports an interrupted batch as `interrupted`, not `done`; a failed list read renders
  an error with retry instead of an empty state (Instances/Batch/IssueCenter).
- A migration-state IPC read failure is a dismissible warning, not a shell-wide migration block.
- Node version rollback creates a `pre-restore-*` snapshot before changing any pack.
- Hard-coded `config.port` and `<instance>/models|custom_nodes|user` assumptions across asset paths.
- IPC sender-frame fail-closed, dev URL exact origin, high-risk zod object schemas.
