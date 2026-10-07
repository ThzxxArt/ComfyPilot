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
    const content = document.querySelector('.content')
    const shell = document.querySelector('.shell')
    const body = document.body
    const html = document.documentElement
    const cs = page ? getComputedStyle(page) : null
    const ccs = content ? getComputedStyle(content) : null
    return {
      hasPage: !!page,
      page: page ? {
        clientHeight: page.clientHeight,
        scrollHeight: page.scrollHeight,
        overflowY: cs.overflowY,
        height: cs.height,
        display: cs.display,
        canScroll: page.scrollHeight > page.clientHeight
      } : null,
      content: content ? {
        clientHeight: content.clientHeight,
        scrollHeight: content.scrollHeight,
        overflowY: ccs.overflowY,
        height: ccs.height,
        display: ccs.display
      } : null,
      shellH: shell ? shell.clientHeight : null,
      bodyH: body.clientHeight,
      bodyOverflow: getComputedStyle(body).overflowY,
      htmlH: html.clientHeight,
      tree: (() => {
        let n = document.getElementById('app')
        const chain = []
        while (n && chain.length < 8) {
          const s = getComputedStyle(n)
          chain.push({
            tag: n.tagName,
            id: n.id,
            cls: String(n.className).slice(0, 60),
            h: n.clientHeight,
            overflowY: s.overflowY,
            display: s.display
          })
          n = n.firstElementChild
        }
        return chain
      })()
    }
  })()`)
  console.log(JSON.stringify(metrics, null, 2))
  // Try wheel scroll
  const before = await win.webContents.executeJavaScript(
    `document.querySelector('.page')?.scrollTop ?? -1`
  )
  // Programmatic scroll proves the container can move
  const prog = await win.webContents.executeJavaScript(
    `(() => { const p=document.querySelector('.page'); if(!p) return -1; p.scrollTop=200; return p.scrollTop })()`
  )
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: 800, y: 500, deltaY: 400, deltaX: 0 })
  await new Promise((r) => setTimeout(r, 500))
  const after = await win.webContents.executeJavaScript(
    `document.querySelector('.page')?.scrollTop ?? -1`
  )
  console.log('scrollTop before=' + before + ' programmatic=' + prog + ' afterWheel=' + after)
  app.exit(0)
})
