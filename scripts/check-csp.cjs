/**
 * 0.2.5 WP7 CSP gate: the renderer must not allow arbitrary network/frame
 * sources. The only permitted connect targets are the dev server and local
 * ComfyUI; frames are disabled (embedding uses a main-process WebContentsView).
 */
const fs = require('fs')
const path = require('path')

const ALLOWED_CONNECT = [
  "'self'",
  'http://localhost:*',
  'ws://localhost:*',
  'http://127.0.0.1:*',
  'ws://127.0.0.1:*'
]

function parsePolicy(html) {
  const tag = /http-equiv=["']Content-Security-Policy["'][^>]*/i.exec(html)
  if (!tag) return ''
  // The policy itself contains single quotes (`'self'`), so a generic
  // `[^"']+` capture stops too early. Match the attribute by its delimiter.
  const m = /content=("([^"]*)"|'([^']*)')/i.exec(tag[0])
  return m ? (m[2] ?? m[3] ?? '') : ''
}

function directive(policy, name) {
  const part = policy
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.toLowerCase().startsWith(name.toLowerCase() + ' '))
  return part ? part.split(/\s+/).slice(1) : []
}

function checkCsp(policy) {
  const errors = []
  if (!policy) return ['missing Content-Security-Policy meta tag']
  const script = directive(policy, 'script-src')
  if (!script.includes("'self'")) errors.push("script-src must include 'self'")
  if (script.some((s) => s.startsWith('http') || s === '*' || s === "'unsafe-inline'")) {
    errors.push('script-src allows a remote/inline script source')
  }
  if (!directive(policy, 'object-src').includes("'none'")) {
    errors.push("object-src must be 'none'")
  }
  const frame = directive(policy, 'frame-src')
  if (!frame.includes("'none'")) errors.push("frame-src must be 'none'")
  const connect = directive(policy, 'connect-src')
  if (!connect.length) {
    errors.push('connect-src is missing')
  } else {
    for (const src of connect) {
      if (!ALLOWED_CONNECT.includes(src)) {
        errors.push(`connect-src allows a non-whitelisted source: ${src}`)
      }
    }
  }
  return errors
}

function main() {
  const file = process.argv[2] || path.join(__dirname, '../src/renderer/index.html')
  const html = fs.readFileSync(file, 'utf8')
  const errors = checkCsp(parsePolicy(html))
  if (errors.length) {
    for (const e of errors) console.error('[check-csp] ' + e)
    process.exit(1)
  }
  console.log('[check-csp] OK — no non-whitelisted network/frame sources')
}

if (require.main === module) main()
module.exports = { parsePolicy, directive, checkCsp }
