# 0.2.5 Coverage Resume State

## Status

- Branch: `feat/0.2.5`
- Coverage is NOT complete. Do not release.
- Latest full `npm run test:coverage` (before the last committed branch tests):
  - Statements: 87.97%
  - Branches: **80.37% (15632/19448)** — gate is 85%
  - Functions: 86.16%
  - Lines: 89.64%
  - Ratchet: 181 files OK
- Commits added after that full run (not yet measured together):
  - `fb01fca` model download refusal/verification branches
  - `security.extra.test.ts` path/URL/settings branches
  - `95f1ead` IPC pip/env/installer/update guards
  - `instanceLayout.extra.test.ts` layout edge branches
  - `d38f825` model walk/metadata/slot branches
  - plus earlier C1/C2 page deep tests and IPC/main/ops/registry/issueHub tests.

## Hard completion criteria

1. `npm run test:coverage`: statements, branches, functions, lines all >= 85%.
2. `node scripts/coverage-ratchet.cjs` passes without lowering `coverage-baseline.json`.
3. `npm run test:behavior`, `npm run test:all`, build, E2E (available parts).
4. Working tree clean; all edits committed locally.
5. Windows 10/11 real-machine scenarios, real ComfyUI/Manager/Civitai, installer install/uninstall/tray/autostart remain **UNVERIFIED** unless actually executed.
6. No `istanbul ignore`, no excluded `.vue`, no baseline/threshold edits, no `coverage:accept`.

## Remaining branch gap (last full lcov)

Need roughly +900 branches. Largest files:

| File | Uncovered branches |
|---|---:|
| `src/main/services/updater.ts` | 147 |
| `src/main/services/installer.ts` | 141 |
| `src/main/services/workflow.ts` | 135 |
| `src/main/services/model.ts` | 134 |
| `src/main/services/bootstrap.ts` | 130 |
| `src/main/index.ts` | 125 |
| `src/main/services/instance/lifecycle.ts` | 124 |
| `src/main/services/env.ts` | 118 |
| `src/main/services/backup.ts` | 112 |
| `src/main/services/nodePack/install.ts` | 109 |
| `src/main/services/monitor.ts` | 94 |
| `src/renderer/src/views/nodes/NodesView.vue` | 88 |

## Recommended next work

Work strictly largest-gap-first. Do not scatter.

1. `tests/unit/updaterPipeline.test.ts` already has a rich fs/exec/session-fetch mock. Add failure-path cases for:
   - copy/backup failure before tree change
   - overlay failure with successful and failed rollback
   - verify-failed journal retained / cleared paths
   - archive pin mismatch, missing manifest/inventory
   - installTorchWith mirror retry and official failure
   - cancel during backup/overlay/streamBody
2. `installerService.test.ts` / install pipeline: preflight/start/abort/checksum/extract/register failures, starter-model install failures.
3. `workflow` tests: malformed PNG chunks, invalid graphs, import/export/copy/queue error paths.
4. `model` tests: scan hash debounce/concurrency, download cancellation/abort, reconcile error paths.
5. `bootstrap` tests: ensure abort, checksum mismatch, HTTP failure, archive extraction failure, uv/python/mingit platform branches.
6. `mainEntry.test.ts`: more app/window events and boot-probe env variants (may require fresh module import with `vi.resetModules`).
7. `lifecycle.ts` via `instanceService.test.ts`: start/stop/restart/forceKill failure and timeout paths.
8. Then run single-file coverage with `--coverage.reportsDirectory=/tmp/...`; only run a full coverage pass when estimate is >=85%.

## Notes

- Full coverage command: `npm run test:coverage > /tmp/fullcov.log 2>&1`
- Ratchet is enforced in `scripts/coverage-ratchet.cjs`.
- Windows/integration/installer checks are external blockers for release, not for coverage work.
- Do not stop to report progress. Continue the loop until all coverage gates pass or a genuine external blocker requires the user.
