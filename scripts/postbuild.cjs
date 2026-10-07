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
