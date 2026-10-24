// Copy non-bundled runtime files into out/ after electron-vite build.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pairs = [
  [path.join(root, 'src/main/bootstrap.cjs'), path.join(root, 'out/main/bootstrap.cjs')]
]

for (const [from, to] of pairs) {
  if (!fs.existsSync(from)) {
    console.error('[postbuild] missing source:', from)
    process.exitCode = 1
    continue
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  console.log('[postbuild] copied', path.relative(root, from), '->', path.relative(root, to))
}

// 0.1.18 (WP0): after the copy, verify every artefact a packaged app needs.
const required = [
  'out/main/index.js',
  'out/main/bootstrap.cjs',
  'out/preload/index.js',
  'out/renderer/index.html'
]
const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)))
if (missing.length) {
  console.error('[postbuild] missing build artefacts:', missing.join(', '))
  process.exitCode = 1
} else {
  console.log('[postbuild] artefacts OK:', required.join(', '))
}
