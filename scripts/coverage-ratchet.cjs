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

const root = process.env.CP_GATE_ROOT
  ? path.resolve(process.env.CP_GATE_ROOT)
  : path.join(__dirname, '..')
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
    current = line
      .slice(3)
      .replace(root + path.sep, '')
      .replace(/\\/g, '/')
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
const accepted = process.argv.includes('--accept')
const allowNew = new Set(
  (process.argv.find((a) => a.startsWith('--allow-new=')) || '')
    .slice('--allow-new='.length)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)
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
  if (!accepted) {
    console.error('[ratchet] --update requires --accept (CI rejects silent baseline rewrites)')
    process.exit(1)
  }
  const removed = Object.keys(baseline).filter(
    (file) => !results.has(file) && !allowNew.has(`deleted:${file}`)
  )
  if (removed.length) {
    for (const file of removed) console.error('[ratchet] MISSING FROM REPORT ' + file)
    console.error(
      '[ratchet] refusing to drop files from the baseline; declare a real deletion with --allow-new=deleted:<path>'
    )
    process.exit(1)
  }
  const newLow = [...results.entries()].filter(
    ([file, m]) => !baseline[file] && !allowNew.has(file) && m.lines < 30
  )
  if (newLow.length) {
    for (const [file, m] of newLow) {
      console.error(`[ratchet] NEW FILE BELOW 30%: ${file} lines=${m.lines.toFixed(2)}%`)
    }
    console.error('[ratchet] add tests for new files before accepting the baseline')
    process.exit(1)
  }
  // Baseline is monotonic: existing floors are NEVER lowered by --update.
  // New files are added at their measured values; files that improved are
  // raised so the ratchet actually tightens over time.
  const next = {}
  for (const [file, metrics] of [...results.entries()].sort()) {
    const before = baseline[file]
    next[file] = before
      ? {
          lines: Math.max(Number(before.lines) || 0, metrics.lines),
          branches: Math.max(Number(before.branches) || 0, metrics.branches),
          functions: Math.max(Number(before.functions) || 0, metrics.functions)
        }
      : metrics
  }
  fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n')
  console.log(`[ratchet] baseline written (${Object.keys(next).length} files, monotonic)`)
  process.exit(0)
}

const drops = []
const gains = []
const newLow = []
for (const [file, metrics] of results) {
  const was = baseline[file]
  if (!was) {
    gains.push(file)
    // New files must carry real tests. 30% lines is the floor; 0% is never ok.
    if (metrics.lines < 30 && !allowNew.has(file))
      newLow.push(`${file} lines=${metrics.lines.toFixed(2)}%`)
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
for (const n of newLow) console.error('[ratchet] NEW FILE BELOW 30% ' + n)
// Every baseline file must still be produced by the suite. A deleted/renamed
// module requires an explicit --allow-new=deleted:<path> declaration.
const missing = Object.keys(baseline).filter(
  (file) => !results.has(file) && !allowNew.has(`deleted:${file}`)
)
for (const m of missing) console.error('[ratchet] MISSING FROM REPORT ' + m)
if (drops.length || newLow.length || missing.length) {
  console.error(
    `\n[ratchet] ${drops.length} drop(s), ${newLow.length} low new file(s), ${missing.length} missing file(s). ` +
      'Fix the regression, or accept explicitly with `node scripts/coverage-ratchet.cjs --update --accept`.'
  )
  process.exit(1)
}
if (gains.length) console.log(`[ratchet] ${gains.length} new file(s) accepted at >=30% lines`)
console.log(`[ratchet] OK — ${results.size} files compared`)
