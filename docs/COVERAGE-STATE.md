# 0.2.6 Coverage State

## Status

Coverage and repository gates are complete for the 0.2.6 working tree. The
version has not been tagged or published yet.

Latest full `npm run test:coverage` result (2026-11-22):

| Metric     |                   Result |
| ---------- | -----------------------: |
| Statements |     91.14% (24850/27264) |
| Branches   | **85.12% (16739/19664)** |
| Functions  |       88.00% (5009/5692) |
| Lines      |     92.48% (21966/23752) |

- Test run: **204 files / 2525 cases passed**.
- Global thresholds: all four metrics are >= 85%.
- Per-file ratchet: OK — 185 files compared (181 existing + 4 new files).
- `npm run test:behavior`: 97.4% (target >= 90%).
- `typecheck`, `typecheck:test`, `lint:check`, `format:check`, version, i18n,
  hardcoded-Chinese, CSP and test-polarity checks pass.
- Production build, `check-asar`, and the Electron smoke E2E pass.
- No `istanbul ignore`, no excluded `.vue` files, no threshold/baseline
  reductions, no `coverage:accept`, no skipped/deleted tests.

## 0.2.6 feature state

- Instance-detail **Attention acceleration** card with SageAttention/xFormers
  status, install/upgrade, self-test and launch-profile switches.
- KJNodes `sageattention is not new enough version` is classified as an
  outdated dependency and routes to the pinned SageAttention 2.2 recipe.
- SageAttention recipe upgraded to the post6 wheel:
  `2.2.0+cu130torch2.10.0andhigher` (SHA-256 pinned).
- xFormers is available as a curated pip recipe on Windows/Linux.
- The self-test IPC runs a fixed script in the instance venv and reports
  package imports, CUDA device facts, and a small attention-kernel result.

## Remaining external verification (UNVERIFIED)

These are release-environment checks, not repository gates. They were **not
executed** in this workspace and must not be reported as passing:

- Full UI walkthrough of the Attention acceleration card on a real Windows
  desktop, including install progress and restart prompts.
- xFormers install and GPU self-test on Windows; only PyPI resolution was
  checked here.
- App-level self-test against a live ComfyUI instance on Windows (the
  SageAttention 2.2 wheel itself was validated directly in the venv).
- Windows NSIS packaging for 0.2.6, install/uninstall, tray and launch-on-boot.
- Code signing and SmartScreen reputation.
- macOS / Linux packages and real-device validation.

## Notes for future work

- The four new files are accepted by the ratchet's new-file floor; future
  changes should raise their floors rather than lowering existing ones.
- Keep the self-test script fixed and review any new attention backend for the
  same import-then-kernel verification.
