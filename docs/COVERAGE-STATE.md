# 0.2.5 Coverage State

## Status

Coverage is complete for the repository gate. The branch: `feat/0.2.5`.

Latest full `npm run test:coverage` result (also reproduced by the final
`npm run test:all`):

| Metric     |                   Result |
| ---------- | -----------------------: |
| Statements |     91.17% (24681/27069) |
| Branches   | **85.07% (16545/19448)** |
| Functions  |       87.92% (4958/5639) |
| Lines      |     92.53% (21820/23581) |

- Global thresholds: all four metrics are >= 85%.
- Per-file ratchet: OK — 181 files compared; baseline not lowered.
- `npm run test:behavior`: 97.4% behaviour ratio, target >= 90%.
- Final `npm run test:all` passed end to end, including:
  - `typecheck`, `typecheck:test`, `lint:check`, `format:check`
  - `test:coverage`, `test:behavior`
  - version, i18n, hardcoded-Chinese, CSP and test-polarity checks
  - production build, `check-asar`, and E2E
- No `istanbul ignore`, no excluded `.vue` files, no threshold/baseline
  reductions, no `coverage:accept`, no skipped/deleted tests.
- No push, tag, or GitHub Release was created.

## Remaining external verification (UNVERIFIED)

These are release-environment checks, not repository coverage gates. They were
**not executed** in this environment and must not be reported as passing:

- Windows 10/11 real-machine scenarios (all ten).
- Real ComfyUI 0.46, Manager 4.4.2, Civitai and cross-machine backup flows.
- Installer install/uninstall, tray, and launch-on-boot on a real Windows host.
- Installer package signing and GitHub CI execution.

## Notes for future work

- Remaining uncovered branches are concentrated in defensive/error-only paths
  and platform-specific code (Windows GPU counters, process tree failure paths).
- The coverage baseline must not be lowered; new code should arrive with tests.
