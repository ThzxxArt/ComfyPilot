#!/usr/bin/env node
/**
 * Asar manifest assertion (0.2.0).
 *
 * `files: out/**` historically shipped out/preload and out/renderer inside the
 * asar AND as extraResources. Three copies made a stale runtime copy look
 * valid. This fails the release if either duplicate reappears.
 *
 * Usage: node scripts/check-asar.cjs [path/to/app.asar]
 * With no argument, checks that electron-builder.yml still excludes both.
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf-8')
const problems = []

if (!/-\s*'?!out\/preload\/\*\*'?/.test(yml)) {
  problems.push("electron-builder.yml must exclude '!out/preload/**'")
}
if (!/-\s*'?!out\/renderer\/\*\*'?/.test(yml)) {
  problems.push("electron-builder.yml must exclude '!out/renderer/**'")
}
if (!/extraResources:/.test(yml) || !/from:\s*out\/preload/.test(yml)) {
  problems.push('preload must ship through extraResources')
}
if (!/from:\s*out\/renderer/.test(yml)) {
  problems.push('renderer must ship through extraResources')
}

const asarPath = process.argv[2]
if (asarPath) {
  const abs = path.resolve(asarPath)
  if (!fs.existsSync(abs)) {
    problems.push(`asar not found: ${abs}`)
  } else {
    try {
      const asar = require('@electron/asar')
      const entries = asar.listPackage(abs).map((p) => p.replace(/\\/g, '/'))
      const dupes = entries.filter(
        (p) => p.startsWith('/out/preload/') || p.startsWith('/out/renderer/')
      )
      if (dupes.length) {
        problems.push(`asar contains duplicate runtime files: ${dupes.slice(0, 5).join(', ')}`)
      }
      if (!entries.some((p) => p.includes('/out/main/'))) {
        problems.push('asar has no out/main payload')
      }
      const resources = path.join(path.dirname(abs), '..', 'preload')
      const renderer = path.join(path.dirname(abs), '..', 'renderer')
      if (!fs.existsSync(resources)) problems.push('extraResources/preload missing')
      if (!fs.existsSync(renderer)) problems.push('extraResources/renderer missing')
    } catch (e) {
      problems.push(`cannot inspect asar: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

if (problems.length) {
  console.error('[check-asar] FAIL')
  for (const p of problems) console.error(' -', p)
  process.exit(1)
}
console.log('[check-asar] OK — no duplicate preload/renderer payload')
