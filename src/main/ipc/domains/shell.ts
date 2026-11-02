import { clipboard, dialog, shell } from 'electron'
import {
  hasExecutableMagic,
  isSafeExternalUrl,
  isSafeOpenPath,
  realpathUnderAnyRoot
} from '../../services/security'
import {
  approvedReadRoots,
  approveReadPath,
  closeEmbed,
  collectRevealRoots,
  openEmbedInternal,
  resizeEmbed,
  wrap,
  type IpcContext
} from '../context'

export function createShellHandlers(ctx: IpcContext) {
  return {
    // app
    checkUpdate: wrap(async () => {
      const { checkAppUpdate } = await import('../../services/appUpdate')
      return checkAppUpdate()
    }),
    updateStatus: wrap(async () => {
      const { getLastAppUpdateStatus } = await import('../../services/appUpdate')
      return getLastAppUpdateStatus()
    }),
    installUpdate: wrap(async () => {
      const { installAppUpdate } = await import('../../services/appUpdate')
      return installAppUpdate()
    }),
    previousExit: wrap(async () => {
      const { getPreviousExitInfo } = await import('../../services/session')
      return getPreviousExitInfo()
    }),
    exportDiagnostics: wrap(async () => {
      const { exportAppDiagnostics } = await import('../../services/session')
      return { path: exportAppDiagnostics() }
    }),

    // shell
    openExternal: wrap(async (url: string) => {
      if (!isSafeExternalUrl(url)) throw new Error(`Blocked unsafe URL: ${url.slice(0, 40)}`)
      await shell.openExternal(url)
      return true
    }),
    openPath: wrap(async (path: string) => {
      if (!isSafeOpenPath(path) || hasExecutableMagic(path)) {
        throw new Error('Blocked opening executable/script file')
      }
      // Opening a file hands it to the OS. Restrict to app-owned/picked roots.
      const roots = [...(await collectRevealRoots()), ...approvedReadRoots]
      const real = realpathUnderAnyRoot(path, roots)
      if (!real) throw new Error('Blocked opening path outside allowed areas')
      const result = await shell.openPath(real)
      return result === ''
    }),
    reveal: wrap(async (path: string) => {
      if (!path || path.includes('\0')) throw new Error('Blocked unsafe path')
      // 0.2.0: realpath containment so a symlink inside an allowed folder
      // cannot reveal an arbitrary target.
      const roots = await collectRevealRoots()
      const real = realpathUnderAnyRoot(path, roots)
      if (!real) throw new Error('Blocked revealing path outside allowed areas')
      shell.showItemInFolder(real)
      return true
    }),
    pickDirectory: wrap(async () => {
      const win = ctx.getWindow()
      const res = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      const chosen = res.canceled ? null : res.filePaths[0]
      approveReadPath(chosen)
      return chosen
    }),
    pickFile: wrap(async (opts?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
      const win = ctx.getWindow()
      const options = { properties: ['openFile' as const], filters: opts?.filters }
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const chosen = res.canceled ? null : res.filePaths[0]
      approveReadPath(chosen)
      return chosen
    }),
    pickFiles: wrap(async (opts?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
      const win = ctx.getWindow()
      const options = {
        properties: ['openFile' as const, 'multiSelections' as const],
        filters: opts?.filters
      }
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      const files = res.canceled ? [] : res.filePaths
      for (const f of files) approveReadPath(f)
      return files
    }),
    writeClipboard: wrap((text: string) => {
      clipboard.writeText(text)
      return true
    }),

    // embed
    embedOpen: wrap((opts: { url: string; title?: string }) =>
      openEmbedInternal(ctx, opts.url, opts.title)
    ),
    embedResize: wrap((rect: { x: number; y: number; width: number; height: number }) =>
      resizeEmbed(rect)
    ),
    embedClose: wrap(() => closeEmbed(ctx))
  }
}
