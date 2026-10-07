/**
 * ZERO LEFTOVER gate: fail when renderer UI strings contain hardcoded Chinese.
 * Comments (// and * lines) are allowed. Locale files are allowed.
 * Exit 1 when violations exist.
 */
const fs = require('fs')
const path = require('path')

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'i18n' || e.name === 'locales') continue
      walk(p, acc)
    } else if (/\.vue$/.test(e.name)) acc.push(p)
  }
  return acc
}

const files = walk(path.join(__dirname, '../src/renderer/src'), [])
// Shared constants feed the UI — Chinese data there leaks via bindings.
const extra = [
  path.join(__dirname, '../src/shared/constants.ts')
].filter((p) => fs.existsSync(p))
let bad = 0
for (const f of [...files, ...extra]) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
  lines.forEach((l, i) => {
    if (!/[一-鿿]/.test(l)) return
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
    const withoutComment = l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    if (!/[一-鿿]/.test(withoutComment)) return
    console.log(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`)
    bad++
  })
}
if (bad) {
  console.log(`HARDCODED CHINESE: ${bad} lines`)
  process.exit(1)
}
console.log('ZERO HARDCODED CHINESE OK')
