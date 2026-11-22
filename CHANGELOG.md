# Changelog

## 0.2.6 — 2026-11-22

> Attention accelerators become a first-class, testable feature.
> **No data migration:** `schemaVersion` remains 2; 0.2.5 data loads as-is.

### Added

- Instance-detail **Attention acceleration** card: SageAttention and xFormers
  status, installed version, compatibility, install/upgrade, self-test and
  launch-profile switches in one place.
- Fixed-script attention self-test (`instance.attentionSelfTest`) runs in the
  instance venv, reports Python/torch/CUDA/GPU architecture, imports both
  optional packages and runs a small CUDA attention kernel. A non-zero exit
  still returns parsed output; failures are never silently marked as usable.
- SageAttention launch switch writes `--use-sage-attention`; xFormers switch
  writes/removes `--disable-xformers`. Both prompt for an instance restart.
- `xformers` curated pip recipe (Windows/Linux, torch >= 2.10).

### Changed

- SageAttention recipe upgraded from the post4 wheel to
  `2.2.0+cu130torch2.10.0andhigher.post6` (SHA-256 pinned), matching the
  current torch 2.10+ / cu130 runtime and the KJNodes 2.2 API requirement.
- Issue Center maps an outdated execution dependency to an actionable issue
  and uses “install/fix dependency” instead of “install missing module”.

### Fixed

- KJNodes `sageattention is not new enough version or could not determine CUDA
architecture` is now classified as an **outdated dependency**, not a missing
  module. The failure card offers the upgrade recipe instead of a plain
  `pip install sageattention` (which still resolves to 1.0.6 on PyPI).
- The old error text no longer sends users down the “missing module” path when
  SageAttention is installed but too old.

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
- Reinstalling over an existing 3.12/3.14/broken venv archives it first instead of failing at the
  version check or overwriting the old environment.
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
- Interpreter/venv approval rejects parent-directory hops instead of matching a
  venv-looking suffix after `..`.
- JSONC now tolerates a UTF-8 BOM (Windows editors) instead of renaming valid data `.bad-*`, and the
  v2 envelope version is authoritative even when a legacy object carries `schemaVersion`.
- Backup restore contains `pythonPath` to interpreter-shaped paths inside the restored instance (or
  a system Python), and rejects hostname `listen` / free-text `--listen` overrides.
- Backup workflow restore only writes `.json`/`.jsonc` documents; an executable dropped via
  `workflow-files` can no longer be referenced by a restored `pythonPath`.
- Batch deadlines follow `/queue`: unrelated history entries no longer cause a 50-second false
  timeout, and a transient queue-probe failure is "unknown", not proof of loss.
- Adopted external instances report `healthy` from the live server instead of a grey `stopped`.
- Node updates refuse a git pack with tracked local changes before any `pull`/`reset --hard`.
- Explicit pip actions (`installSpec` / specs / recipes / requirements) now honor `networkMode=offline`
  and `allowPipInstall`, closing the bypass around the node-pack gate.
- Stable-tag ComfyUI archives are SHA-256 continuity-pinned after the first verified update; a
  changed archive for the same tag is refused. Nightly stays on the mutable master archive.
