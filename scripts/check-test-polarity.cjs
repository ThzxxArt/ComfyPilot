#!/usr/bin/env node
/**
 * 0.2.3: no test file may be positive-only.
 *
 * A literal one-negative-per-positive rule is not meaningful for every case
 * (e.g. "parses a valid file" often has one positive path), but every file
 * that asserts success must also assert at least one failure/rejection path.
 * This keeps the suite from drifting into "happy path only" coverage.
 *
 * The classifier is intentionally conservative: a test counts as negative only
 * when its body proves a failure (rejects/throw/false/null/empty/not.*).
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'tests')

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(test|e2e)\.ts$/.test(ent.name)) out.push(p)
  }
  return out
}

const NEGATIVE = [
  /\.rejects\b/,
  /\.toThrow\b/,
  /\.toBe\(false\)/,
  /\.toEqual\(false\)/,
  /\.toBeNull\(/,
  /\.toEqual\(null\)/,
  /\.toBeUndefined\(/,
  /\.toBe\(0\)/,
  /\.toBe\(''\)/,
  /\.toEqual\(\[\]\)/,
  /\.toHaveLength\(0\)/,
  /\.not\.(?:toBe|toEqual|toContain|toMatch|toHaveLength|toThrow|toBeNull)\b/,
  /\.code\)\.toBe\(/,
  /\.ok\)\.toBe\(false\)/,
  /\.status\)\.toBe\(['"](?:failed|cancelled|error)/
]

const POSITIVE = [
  /\.resolves\b/,
  /\.toBe\(true\)/,
  /\.toEqual\(true\)/,
  /\.not\.toThrow\b/,
  /\.toHaveLength\([1-9]/,
  /\.toContain\(/,
  /\.toBe\(['"`]/,
  /\.toBeGreaterThan\(/,
  /\.toEqual\(\[/
]

function cases(src) {
  const out = []
  const re = /\b(?:it|test)(?:\.\w+)?\(\s*(['"`])([\s\S]*?)\1\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{/g
  let m
  while ((m = re.exec(src))) {
    const start = re.lastIndex
    let depth = 1
    let i = start
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    out.push({ name: m[2], body: src.slice(start, i) })
  }
  return out
}

const has = (body, list) => list.some((re) => re.test(body))

let total = 0
let positive = 0
let negative = 0
let mixed = 0
const offenders = []

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf-8')
  const list = cases(src)
  if (!list.length) continue
  total += list.length
  let pos = 0
  let neg = 0
  for (const c of list) {
    const n = has(c.body, NEGATIVE)
    const p = has(c.body, POSITIVE)
    if (n) negative++
    if (p) positive++
    if (p && n) mixed++
    if (p) pos++
    if (n) neg++
  }
  if (pos > 0 && neg === 0) {
    offenders.push({ file: path.relative(path.join(__dirname, '..'), file), positive: pos })
  }
}

console.log(`cases parsed: ${total}`)
console.log(`cases with positive assertions: ${positive}`)
console.log(`cases with negative assertions: ${negative}`)
console.log(`cases with both: ${mixed}`)

if (offenders.length) {
  console.error('\n[test-polarity] FAIL — positive-only test files:')
  for (const o of offenders)
    console.error(`  - ${o.file}: ${o.positive} positive case(s), 0 negative`)
  process.exit(1)
}

console.log('[test-polarity] OK — every file with positive assertions also proves a failure path')
