#!/usr/bin/env node
/**
 * 0.1.18 (WP8): measure how much of the suite actually exercises behaviour.
 *
 * The 0.1.17 suite contained ~1,100 cases that only read source text and
 * asserted on strings, plus some tautologies. Those pass even when the product
 * is broken, so the "all green" number was misleading. This script classifies
 * every `it`/`test` body and reports the behaviour ratio; it exits non-zero
 * only when `--fail` is passed and the ratio is below the target.
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'tests')
const TARGET = 60

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(test|e2e)\.ts$/.test(ent.name)) out.push(p)
  }
  return out
}

/** Split a file into test cases: name + body text. */
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

let total = 0
let textOnly = 0
let tautology = 0
const byFile = []

for (const file of walk(root)) {
  const src = fs.readFileSync(file, 'utf-8')
  const list = cases(src)
  let localText = 0
  let localTaut = 0
  for (const c of list) {
    const readsSrc = /readFileSync\(|readSrc\(/.test(c.body)
    const textAssert = /toContain\(|toMatch\(|toMatchInlineSnapshot\(/.test(c.body)
    const taut =
      /expect\(\s*(true|1)\s*\)\.toBe\(\s*(true|1)\s*\)/.test(c.body) ||
      /expect\(\s*([A-Za-z_$][\w$]*)\s*\)\.toBe\(\s*\1\s*\)/.test(c.body)
    if (taut) {
      localTaut++
      tautology++
    } else if (readsSrc && textAssert) {
      localText++
      textOnly++
    }
  }
  total += list.length
  if (localText || localTaut) {
    byFile.push({
      file: path.relative(path.join(__dirname, '..'), file),
      cases: list.length,
      textOnly: localText,
      tautology: localTaut
    })
  }
}

const behaviour = total - textOnly - tautology
const ratio = total ? (behaviour / total) * 100 : 100
console.log(`cases: ${total}`)
console.log(`source-text-only: ${textOnly}`)
console.log(`tautological: ${tautology}`)
console.log(`behaviour ratio: ${ratio.toFixed(1)}% (target ≥ ${TARGET}%)`)
if (byFile.length) {
  console.log(`\nworst files:`)
  byFile
    .sort((a, b) => b.textOnly + b.tautology - (a.textOnly + a.tautology))
    .slice(0, 15)
    .forEach((f) =>
      console.log(
        `  ${f.file}: ${f.cases} cases (${f.textOnly} text, ${f.tautology} tautology)`
      )
    )
}
if (process.argv.includes('--fail') && ratio < TARGET) process.exit(1)
