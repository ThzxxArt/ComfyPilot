import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcChannelMap, IpcResult } from '@shared/types'
import { IPC_EVENTS } from '@shared/types'

async function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcChannelMap[C]['args']
): Promise<IpcResult<IpcChannelMap[C]['result']>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<IpcChannelMap[C]['result']>>
}

function on(event: string, listener: (...args: unknown[]) => void): () => void {
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
