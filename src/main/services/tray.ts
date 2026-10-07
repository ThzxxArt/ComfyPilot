import { Tray, Menu, nativeImage, BrowserWindow, app, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { APP_NAME } from '@shared/constants'
import type { ComfyInstanceInfo } from '@shared/types'
import { instanceService } from './instance'
import { isSafeExternalUrl } from './security'

let tray: Tray | null = null
let onShowWindow: (() => void) | null = null

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
        label: inst.status === 'running' ? '停止' : '启动并打开',
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
        label: '打开 Frontend',
        enabled: Boolean(inst.url),
        click: () => {
          if (inst.url && isSafeExternalUrl(inst.url)) void shell.openExternal(inst.url)
        }
      },
      {
        label: '显示主窗口',
        click: () => onShowWindow?.()
      }
    ]
  }))

  return Menu.buildFromTemplate([
    {
      label: `${APP_NAME} · ${running.length} 运行中 / ${instances.length} 实例`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: '显示主窗口',
      click: () => onShowWindow?.()
    },
    {
      label: '启动全部实例',
      enabled: stopped.length > 0,
      click: () => {
        void instanceService.startAll().then(refreshTray)
      }
    },
    {
      label: '停止全部实例',
      enabled: running.length > 0,
      click: () => {
        void instanceService.stopAll().then(refreshTray)
      }
    },
    { type: 'separator' },
    ...(instanceItems.length
      ? (instanceItems as Electron.MenuItemConstructorOptions[])
      : [{ label: '（暂无实例）', enabled: false } as Electron.MenuItemConstructorOptions]),
    { type: 'separator' },
    {
      label: '退出',
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
    const menu = await buildMenu()
    tray.setContextMenu(menu)
    const list = instanceService.list()
    const running = list.filter((i) => i.status === 'running').length
    tray.setToolTip(`${APP_NAME} — ${running}/${list.length} 实例运行中`)
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
