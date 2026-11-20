# Release checklist

## 1. Version

- [ ] `package.json`, `package-lock.json`, `src/shared/constants.ts`, `README.md` all report the
      same version.
- [ ] `node scripts/check-version.cjs` passes.
- [ ] `CHANGELOG.md` has the release entry.

## 2. Gates (must be green before tagging)

- [ ] `npm run typecheck`
- [ ] `npm run typecheck:test`
- [ ] `npm run lint:check`
- [ ] `npm run format:check`
- [ ] `npm run test:coverage` (ratchet included)
- [ ] `npm run test:behavior`
- [ ] `node scripts/check-i18n.cjs`
- [ ] `node scripts/check-hardcoded-zh.cjs`
- [ ] `node scripts/check-test-polarity.cjs`
- [ ] `node scripts/check-version.cjs`
- [ ] `npm run build`
- [ ] `node scripts/check-asar.cjs`
- [ ] `npm run test:e2e` (Linux under xvfb)

## 3. Packaging proof

- [ ] `npx electron-builder --win --dir`
- [ ] `release/win-unpacked/ComfyPilot.exe --e2e-smoke` exits 0.
- [ ] `node scripts/check-asar.cjs release/win-unpacked/resources/app.asar` passes.
- [ ] NSIS installer builds; install/uninstall produces no Application Error.
- [ ] `SHA256SUMS.txt` contains installer, blockmap and `latest.yml`.

## 4. Real-device acceptance (Windows 10/11)

Execute `docs/PLAN-0.2.5.md` §8.2 scenarios 1–10. Record pass/fail/未验证 per scenario. Do not claim
a scenario passed based on unit tests.

## 5. Publish

- [ ] Tag `v<version>` matches `package.json`.
- [ ] Draft release notes include: no data migration (`schemaVersion` 2), legacy instances stay
      nightly, auto-recovery is off by default, rescue commands, TLS warning, macOS/Linux status,
      node rollback v1 scope, Manager writes default read-only.
- [ ] Upload checksums and the unsigned-installer warning.
- [ ] Verify the draft after a clean install on a second machine.

## Rollback

- App update: reinstall the previous installer; data remains schemaVersion 2.
- ComfyUI source update: use the instance detail “rollback update” action (journal + backup), or the
  pre-update backup under the instance parent `.cp-backups/<timestamp>`.
- Node versions: `node.restoreVersions` / snapshot restore (git exact, registry best-effort, local
  packs require manual action).
