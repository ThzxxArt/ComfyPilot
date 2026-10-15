// Minimal CJS bootstrap — logs every step to diagnose silent startup death.
const fs = require('fs')
const os = require('os')
const path = require('path')

function logDir() {
  // Real Electron userData (app `name` = "comfy-pilot"), NOT the old hardcoded
  // `%APPDATA%/ComfyPilot` — see db.migrateLegacyLogs (0.1.16).
  try {
    const base = require('electron').app.getPath('userData')
    if (base) return path.join(base, 'logs')
  } catch {
    /* app not resolvable yet — fall through */
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', 'comfy-pilot', 'logs')
}

function log(msg) {
  try {
    const dir = logDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'boot.log'), `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}

log('bootstrap start')
try {
  log('electron version: ' + process.versions.electron + ' node: ' + process.versions.node)
  log('resourcesPath: ' + process.resourcesPath)
  log('__dirname: ' + __dirname)
} catch (e) {
  log('meta fail ' + e)
}

try {
  require('./index.js')
  log('index.js required OK')
} catch (e) {
  log('index.js REQUIRE FAIL: ' + (e && e.stack ? e.stack : e))
  process.exitCode = 1
  try {
    const { app, dialog } = require('electron')
    app.whenReady().then(() => {
      dialog.showErrorBox('ComfyPilot startup failed', String(e && e.stack ? e.stack : e))
      app.exit(1)
    })
  } catch (e2) {
    log('dialog fail ' + e2)
    try {
      require('electron').app.exit(1)
    } catch {
      process.exit(1)
    }
  }
}
