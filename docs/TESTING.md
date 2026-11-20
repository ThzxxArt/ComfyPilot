# Testing

## Quick loop

```bash
npm run typecheck        # main + renderer
npm run typecheck:test   # tests
npm run test             # unit + integration (148+ files)
npm run test:quick       # typecheck + unit tests
```

## Full gate (same as CI)

```bash
npm run lint:check
npm run format:check
npm run test:coverage            # vitest + per-file ratchet
npm run test:behavior            # behaviour ratio (target >= 90%)
node scripts/check-version.cjs
node scripts/check-i18n.cjs
node scripts/check-hardcoded-zh.cjs
node scripts/check-csp.cjs
node scripts/check-test-polarity.cjs
npm run build
node scripts/check-asar.cjs
npm run test:e2e                 # Linux: xvfb-run -a npm run test:e2e
```

`npm run test:all` runs the complete sequence above. It is intentionally slow; use `test:quick`
while iterating.

## Coverage ratchet

- `coverage-baseline.json` is per-file and committed.
- Any file dropping >1pp fails.
- A baseline file missing from the report fails.
- A new file below 30% lines fails.
- `npm run coverage:accept` (= `--update --accept`) refuses to lower the baseline or remove files.
  Deleting/renaming a module requires an explicit `--allow-new=deleted:<path>` declaration.

## What is covered where

| Area                                | Representative tests                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Effective port/listen/dirs          | `tests/unit/instanceLayout.test.ts`, `tests/unit/outputDir.test.ts`                                      |
| Health state machine + real HTTP    | `tests/unit/health.test.ts`, `tests/helpers/fakeComfyServer.ts`                                          |
| Rescue/control/safe mode            | `tests/unit/control.test.ts`                                                                             |
| Installer run isolation / env truth | `tests/integration/installerRunPlan.test.ts`, `tests/unit/envTruth.test.ts`                              |
| Manager v4.4                        | `tests/unit/managerConfig.test.ts`, `tests/unit/managerChannel.test.ts`                                  |
| Stable updates / node rollback      | `tests/unit/updaterPipeline.test.ts`, `tests/unit/nodePackUpdate.test.ts`                                |
| Runtime matrix                      | `tests/unit/wp6RuntimeMatrix.test.ts`                                                                    |
| Security boundaries                 | `tests/unit/wp025PathCapability.test.ts`, `wp025DownloadSecurity.test.ts`, `wp025OutputSecurity.test.ts` |
| Desktop shortcuts / autostart       | `tests/unit/desktopService.test.ts`, `tests/unit/trayService.test.ts`                                    |
| Migration failure / rollback        | `tests/unit/dataMigration.test.ts`                                                                       |
| Release gates                       | `tests/unit/gates.test.ts` (coverage ratchet, asar, CSP)                                                 |

## Windows packaged smoke

```powershell
npx electron-builder --win --dir
.\release\win-unpacked\ComfyPilot.exe --e2e-smoke
```

The smoke launch must exit 0, create no console errors, and prove preload/renderer/IPC wiring in the
packaged layout.

## Real-instance acceptance

The 10 Windows scenarios are listed in `docs/PLAN-0.2.5.md` §8.2. Unit tests cannot substitute for
them. Any scenario not executed on a real Windows 10/11 machine must be reported as **未验证**.
