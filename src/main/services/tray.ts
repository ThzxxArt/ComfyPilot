import { Tray, Menu, nativeImage, BrowserWindow, app, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { APP_NAME } from '@shared/constants'
import type { ComfyInstanceInfo } from '@shared/types'
import { instanceService } from './instance'
import { isSafeExternalUrl } from './security'
import { loadSettings } from './db'

let tray: Tray | null = null
let onShowWindow: (() => void) | null = null

type TrayStrings = {
  stop: string
  launch: string
  openFrontend: string
  showWindow: string
  startAll: string
  stopAll: string
  noInstances: string
  quit: string
  header: (r: number, t: number) => string
  tip: (r: number, t: number) => string
}

const TRAY_STRINGS: Record<'zh-CN' | 'en-US', TrayStrings> = {
  'zh-CN': {
    stop: '停止',
    launch: '启动并打开',
    openFrontend: '打开 Frontend',
    showWindow: '显示主窗口',
    startAll: '启动全部实例',
    stopAll: '停止全部实例',
    noInstances: '（暂无实例）',
    quit: '退出',
    header: (r: number, t: number) => `${APP_NAME} · ${r} 运行中 / ${t} 实例`,
    tip: (r: number, t: number) => `${APP_NAME} — ${r}/${t} 实例运行中`
  },
  'en-US': {
    stop: 'Stop',
    launch: 'Launch & open',
    openFrontend: 'Open Frontend',
    showWindow: 'Show window',
    startAll: 'Start all instances',
    stopAll: 'Stop all instances',
    noInstances: '(no instances)',
    quit: 'Quit',
    header: (r: number, t: number) => `${APP_NAME} · ${r} running / ${t} total`,
    tip: (r: number, t: number) => `${APP_NAME} — ${r}/${t} running`
  }
}

function trayT(): TrayStrings {
  const locale = loadSettings().locale
  return locale === 'en-US' ? TRAY_STRINGS['en-US'] : TRAY_STRINGS['zh-CN']
}

function resolveTrayIcon(): Electron.NativeImage {
  const bases = [
    join(process.resourcesPath || '', 'resources'),
    join(app.getAppPath(), 'resources'),
    join(__dirname, '../../resources')
  ]
  const names = ['comfypilot-windows-256.png', 'comfypilot-appstore-120.png', 'ComfyPilot.ico']
  for (const base of bases) {
    for (const name of names) {
      const p = join(base, name)
      try {
        if (existsSync(p)) {
          const img = nativeImage.createFromPath(p)
          if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
        }
      } catch {
        /* ignore */
      }
    }
  }
  return nativeImage.createEmpty()
}

async function buildMenu(): Promise<Menu> {
  const s = trayT()
  let instances: ComfyInstanceInfo[] = []
  try {
    instances = instanceService.list()
  } catch {
    instances = []
  }
  const running = instances.filter((i) => i.status === 'running')
  const stopped = instances.filter((i) => i.status !== 'running' && i.status !== 'starting')

  const instanceItems: Electron.MenuItemConstructorOptions[] = instances.slice(0, 12).map((inst) => ({
    label: `${inst.status === 'running' ? '●' : '○'} ${inst.name} :${inst.port}`,
    submenu: [
      {
        label: inst.status === 'running' ? s.stop : s.launch,
        click: () => {
          void (async () => {
            try {
              if (inst.status === 'running') await instanceService.stop(inst.id)
              else await instanceService.launch(inst.id)
            } catch {
              /* tray is best-effort */
            }
            refreshTray()
          })()
        }
      },
      {
        label: s.openFrontend,
        enabled: Boolean(inst.url),
        click: () => {
          if (inst.url && isSafeExternalUrl(inst.url)) void shell.openExternal(inst.url)
        }
      },
      {
        label: s.showWindow,
        click: () => onShowWindow?.()
      }
    ]
  }))

  return Menu.buildFromTemplate([
    {
      label: s.header(running.length, instances.length),
      enabled: false
    },
    { type: 'separator' },
    {
      label: s.showWindow,
      click: () => onShowWindow?.()
    },
    {
      label: s.startAll,
      enabled: stopped.length > 0,
      click: () => {
        void instanceService.startAll().then(refreshTray)
      }
    },
    {
      label: s.stopAll,
      enabled: running.length > 0,
      click: () => {
        void instanceService.stopAll().then(refreshTray)
      }
    },
    { type: 'separator' },
    ...(instanceItems.length
      ? (instanceItems as Electron.MenuItemConstructorOptions[])
      : [{ label: s.noInstances, enabled: false } as Electron.MenuItemConstructorOptions]),
    { type: 'separator' },
    {
      label: s.quit,
      click: () => {
        try {
          instanceService.killAllNow()
        } catch {
          /* ignore */
        }
        app.quit()
      }
    }
  ])
}

export async function refreshTray(): Promise<void> {
  if (!tray) return
  try {
    const s = trayT()
    const menu = await buildMenu()
    tray.setContextMenu(menu)
    const list = instanceService.list()
    const running = list.filter((i) => i.status === 'running').length
    tray.setToolTip(s.tip(running, list.length))
  } catch {
    /* ignore */
  }
}

export function createTray(handlers: { onShowWindow: () => void }): void {
  if (tray) return
  onShowWindow = handlers.onShowWindow
  const icon = resolveTrayIcon()
  tray = new Tray(icon)
  tray.on('click', () => onShowWindow?.())
  tray.on('double-click', () => onShowWindow?.())
  void refreshTray()
  // Keep the menu fresh as instance status changes
  instanceService.on('status', () => {
    void refreshTray()
  })
}

export function destroyTray(): void {
  if (tray) {
    try {
      tray.destroy()
    } catch {
      /* ignore */
    }
    tray = null
  }
}

export function hasTray(): boolean {
  return tray !== null
}

export function showMainWindow(): void {
  const wins = BrowserWindow.getAllWindows()
  if (wins[0]) {
    wins[0].show()
    wins[0].focus()
  } else {
    onShowWindow?.()
  }
}
