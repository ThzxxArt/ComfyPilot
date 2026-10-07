import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcChannelMap, IpcResult } from '@shared/types'
import { IPC_EVENTS } from '@shared/types'

const ALLOWED_EVENTS = new Set<string>(Object.values(IPC_EVENTS))

/**
 * Electron IPC uses the structured clone algorithm, which REJECTS Vue
 * reactive Proxies, functions, DOM nodes and class instances with
 * "An object could not be cloned.".
 *
 * Every argument must be reduced to plain JSON data before crossing the
 * bridge. JSON round-trip is the only transform that also unwraps Proxies
 * (JSON.stringify walks them via get traps).
 */
export function toPlainIpcArg<T>(value: T): T {
  if (value === undefined) return value
  if (value === null) return value
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    // Non-serializable on its own — last resort is to pass a placeholder
    // rather than crash the whole invoke with a clone error.
    return null as unknown as T
  }
}

async function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcChannelMap[C]['args']
): Promise<IpcResult<IpcChannelMap[C]['result']>> {
  const plainArgs = args.map((a) => toPlainIpcArg(a)) as IpcChannelMap[C]['args']
  return ipcRenderer.invoke(channel, ...plainArgs) as Promise<
    IpcResult<IpcChannelMap[C]['result']>
  >
}

function on(event: string, listener: (...args: unknown[]) => void): () => void {
  if (!ALLOWED_EVENTS.has(event)) {
    console.warn('[ComfyPilot] blocked subscription to unknown event', event)
    return () => undefined
  }
  const handler = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => listener(...args)
  ipcRenderer.on(event, handler)
  return () => ipcRenderer.removeListener(event, handler)
}

const api = {
  invoke,
  on,
  events: IPC_EVENTS
}

export type ComfyPilotApi = typeof api

contextBridge.exposeInMainWorld('comfyPilot', api)

