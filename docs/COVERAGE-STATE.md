# 0.2.5 Coverage State

## Status

Coverage is complete and merged to `master`. The v0.2.5 Windows release has
been packaged and published.

Latest full `npm run test:coverage` result (2026-11-21, release commit
`7e82a0f87acef6325f2e10cef5f938fe95b4f8f7`):

| Metric     |                   Result |
| ---------- | -----------------------: |
| Statements |     91.21% (24694/27072) |
| Branches   | **85.12% (16555/19448)** |
| Functions  |       87.94% (4960/5640) |
| Lines      |     92.55% (21828/23583) |

- Test run: **200 files / 2493 cases passed**.
- Global thresholds: all four metrics are >= 85%.
- Per-file ratchet: OK — 181 files compared; baseline not lowered.
- `npm run test:behavior`: passed (>= 90% behaviour ratio).
- The same gate set passed locally and in CI, including:
  - `typecheck`, `typecheck:test`, `lint:check`, `format:check`
  - `test:coverage`, `test:behavior`
  - version, i18n, hardcoded-Chinese, CSP and test-polarity checks
  - production build, `check-asar`, and E2E
- CI run `44896208023`: Windows and Ubuntu jobs both succeeded.  
  https://github.com/ThzxxArt/ComfyPilot/actions/runs/44896208023
- No `istanbul ignore`, no excluded `.vue` files, no threshold/baseline
  reductions, no `coverage:accept`, no skipped/deleted tests.

## Release packaging

- Windows NSIS x64 installer built by WSL invoking the Windows-side Node.js and
  electron-builder (`ComfyPilot-0.2.5-win-x64.exe`).
- `release/win-unpacked/ComfyPilot.exe --e2e-smoke` passed: renderer mounted,
  preload bridge present, IPC round-trip OK (PLAN §8.2 scenario 10).
- `check-asar` passed against the real packaged `app.asar`.
- `latest.yml` and all version consumers report `0.2.5`.
- Published release: https://github.com/ThzxxArt/ComfyPilot/releases/tag/v0.2.5

## Remaining external verification (UNVERIFIED)

These are release-environment checks, not repository coverage gates. They were
**not executed** in this environment and must not be reported as passing:

- Windows 10/11 real-machine scenarios 1–9 (stuck detection, lock-screen
  rescue, safe mode, Manager 4.4.2, stable update/rollback, custom directories,
  port/listen overrides, security boundary attempts, Civitai/batch/backup).
- Installer install/uninstall, tray, and launch-on-boot on a real Windows host.
- Real ComfyUI 0.46, Manager 4.4.2, Civitai and cross-machine backup flows.
- Installer package signing and SmartScreen reputation; the installer is
  unsigned.
- macOS / Linux packages and real-device validation; this release ships Windows
  x64 only.

## Notes for future work

- Remaining uncovered branches are concentrated in defensive/error-only paths
  and platform-specific code (Windows GPU counters, process tree failure paths).
- The coverage baseline must not be lowered; new code should arrive with tests.
