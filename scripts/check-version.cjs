#!/usr/bin/env node
/**
 * 0.1.18 (WP0): one source of truth for the version string.
 *
 * Version drift has shipped three times: package.json bumped, lockfile left
 * behind, README still advertising the previous release. This script fails CI
 * (and `npm run check:version`) unless every consumer agrees.
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const problems = []

function read(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf-8')
  } catch {
    problems.push(`missing file: ${rel}`)
    return ''
  }
}

const pkg = JSON.parse(read('package.json') || '{}')
const version = String(pkg.version || '')
if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`package.json version is invalid: "${version}"`)

const lockRaw = read('package-lock.json')
if (lockRaw) {
  try {
    const lock = JSON.parse(lockRaw)
    if (lock.version !== version) {
      problems.push(`package-lock.json version ${lock.version} != ${version}`)
    }
    const rootPkg = lock.packages && lock.packages['']
    if (rootPkg && rootPkg.version !== version) {
      problems.push(`package-lock.json packages[""].version ${rootPkg.version} != ${version}`)
    }
  } catch (e) {
    problems.push(`package-lock.json is not valid JSON: ${e.message}`)
  }
}

const constants = read('src/shared/constants.ts')
// APP_VERSION is `(injected) || 'x.y.z'` — the literal is the dev fallback.
const constMatch =
  constants.match(/APP_VERSION[^\n]*\|\|\s*['"](\d+\.\d+\.\d+)['"]/) ||
  constants.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
if (!constMatch) problems.push('src/shared/constants.ts has no APP_VERSION')
else if (constMatch[1] !== version) {
  problems.push(`src/shared/constants.ts APP_VERSION ${constMatch[1]} != ${version}`)
}

const readme = read('README.md')
if (readme && !readme.includes(`v${version}`)) {
  problems.push(`README.md does not mention v${version}`)
}

// `release/` holds build output, not source: a stale latest.yml from an older
// local build must not fail the repository check. Release CI sets
// CHECK_RELEASE_META=1 AFTER building, where agreement is meaningful.
const latest = process.env.CHECK_RELEASE_META === '1' ? read('release/latest.yml') : ''
if (latest) {
  const m = latest.match(/^version:\s*(\S+)/m)
  if (!m) problems.push('release/latest.yml has no version field')
  else if (m[1] !== version) problems.push(`release/latest.yml version ${m[1]} != ${version}`)
}

if (problems.length) {
  console.error('[check-version] FAILED:')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log(`[check-version] OK — all consumers report ${version}`)
