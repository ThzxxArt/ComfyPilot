#!/usr/bin/env node
/**
 * 0.1.18 (WP8): per-file coverage ratchet.
 *
 * The global threshold in vitest.config.ts can hide a module collapsing from
 * 90% → 40% while other files carry the average. This compares every file in
 * lcov against a recorded baseline and fails when any file drops >1pp.
 *
 *   node scripts/coverage-ratchet.cjs           # check
 *   node scripts/coverage-ratchet.cjs --update  # accept the current numbers
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const lcovPath = path.join(root, 'coverage', 'lcov.info')
const baselinePath = path.join(root, 'coverage-baseline.json')
const MAX_DROP = 1

if (!fs.existsSync(lcovPath)) {
  console.error('[ratchet] coverage/lcov.info missing — run `npx vitest run --coverage` first')
  process.exit(1)
}

const files = new Map()
let current = null
let acc = null
const pct = (hit, found) => (found ? (hit / found) * 100 : 100)
const value = (line) => Number(line.slice(line.indexOf(':') + 1))
for (const raw of fs.readFileSync(lcovPath, 'utf-8').split('\n')) {
  const line = raw.trim()
  if (line.startsWith('SF:')) {
    current = line.slice(3).replace(root + path.sep, '').replace(/\\/g, '/')
    acc = { lh: 0, lf: 0, brh: 0, brf: 0, fnh: 0, fnf: 0 }
  } else if (line.startsWith('LH:') && acc) acc.lh = value(line)
  else if (line.startsWith('LF:') && acc) acc.lf = value(line)
  else if (line.startsWith('BRH:') && acc) acc.brh = value(line)
  else if (line.startsWith('BRF:') && acc) acc.brf = value(line)
  else if (line.startsWith('FNH:') && acc) acc.fnh = value(line)
  else if (line.startsWith('FNF:') && acc) acc.fnf = value(line)
  else if (line === 'end_of_record' && current && acc) {
    // A file can appear in several records (parallel workers / merged reports).
    // MERGE the counters — overwriting kept only the last fragment, which made
    // partially-covered files look 100% covered.
    const prev = files.get(current) || { lh: 0, lf: 0, brh: 0, brf: 0, fnh: 0, fnf: 0 }
    files.set(current, {
      lh: prev.lh + acc.lh,
      lf: prev.lf + acc.lf,
      brh: prev.brh + acc.brh,
      brf: prev.brf + acc.brf,
      fnh: prev.fnh + acc.fnh,
      fnf: prev.fnf + acc.fnf
    })
    current = null
    acc = null
  }
}

// Convert merged counters to percentages once, for both modes.
const results = new Map()
for (const [file, c] of files) {
  results.set(file, {
    lines: Number(pct(c.lh, c.lf).toFixed(2)),
    branches: Number(pct(c.brh, c.brf).toFixed(2)),
    functions: Number(pct(c.fnh, c.fnf).toFixed(2))
  })
}

const update = process.argv.includes('--update')
const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
  : {}

// A missing/empty baseline must FAIL rather than silently re-baseline the
// tree: otherwise deleting the file turns the ratchet into a no-op.
if (!update && Object.keys(baseline).length === 0) {
  console.error(
    '[ratchet] coverage-baseline.json is missing or empty — commit it, or run: npm run coverage:accept'
  )
  process.exit(1)
}

if (update) {
  const next = {}
  for (const [file, metrics] of [...results.entries()].sort()) next[file] = metrics
  fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
  console.log(`[ratchet] baseline written (${Object.keys(next).length} files)`)
  process.exit(0)
}

const drops = []
const gains = []
for (const [file, metrics] of results) {
  const was = baseline[file]
  if (!was) {
    gains.push(file)
    continue
  }
  for (const metric of ['lines', 'branches', 'functions']) {
    const before = was[metric]
    if (typeof before !== 'number') continue
    if (metrics[metric] < before - MAX_DROP) {
      drops.push(`${file} ${metric}: ${before.toFixed(2)}% → ${metrics[metric].toFixed(2)}%`)
    }
  }
}
for (const d of drops) console.error('[ratchet] DROP ' + d)
if (drops.length) {
  console.error(
    `\n[ratchet] ${drops.length} file(s) dropped more than ${MAX_DROP}pp. ` +
      'Fix the regression, or accept it explicitly with `node scripts/coverage-ratchet.cjs --update`.'
  )
  process.exit(1)
}
if (gains.length) console.log(`[ratchet] ${gains.length} new file(s) not in baseline (informational)`)
console.log(`[ratchet] OK — ${results.size} files compared`)
