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
    const body = document.querySelector('.page-body')
    const content = document.querySelector('.content')
    const cs = page ? getComputedStyle(page) : null
    return {
      hasPage: !!page,
      page: page ? {
        clientHeight: page.clientHeight,
        scrollHeight: page.scrollHeight,
        overflowY: cs.overflowY,
        canScroll: page.scrollHeight > page.clientHeight + 1
      } : null,
      pageBody: body ? {
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        overflowY: getComputedStyle(body).overflowY,
        canScroll: body.scrollHeight > body.clientHeight + 1
      } : null,
      contentOverflow: content ? getComputedStyle(content).overflowY : null
    }
  })()`)
  console.log(JSON.stringify(metrics, null, 2))
  app.exit(0)
})
