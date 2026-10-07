/**
 * Scroll diagnostic — boots the built app and reports scroll metrics.
 * Run: node scripts/diag-scroll.cjs
 */
const { spawn } = require('child_process')
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')
const { app, BrowserWindow } = require('electron')

const root = join(__dirname, '..')
const outHtml = join(root, 'out', 'renderer', 'index.html')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    webPreferences: {
      preload: join(root, 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  await win.loadFile(outHtml)
  await new Promise((r) => setTimeout(r, 1500))
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const page = document.querySelector('.page')
    const header = document.querySelector('.page-header')
    const body = document.querySelector('.page-body') || document.querySelector('.n-tabs-pane-wrapper') || document.querySelector('.n-tab-pane')
    const hr = header?.getBoundingClientRect()
    const br = body?.getBoundingClientRect()
    return {
      header: header ? { height: Math.round(hr.height), bottom: Math.round(hr.bottom) } : null,
      bodyTop: br ? Math.round(br.top) : null,
      gap: hr && br ? Math.round(br.top - hr.bottom) : null,
      pageOverflow: page ? getComputedStyle(page).overflowY : null,
      bodyOverflow: body ? getComputedStyle(body).overflowY : null,
      bodyCanScroll: body ? body.scrollHeight > body.clientHeight + 1 : null,
      firstListTop: (() => {
        const el = document.querySelector('.n-list, .cards, .grid, .n-data-table')
        return el ? Math.round(el.getBoundingClientRect().top) : null
      })(),
      versionSample: Array.from(document.querySelectorAll('.tags .n-tag')).slice(0, 8).map(n => n.textContent.trim())
    }
  })()`)
  console.log(JSON.stringify(metrics, null, 2))
  app.exit(0)
})
