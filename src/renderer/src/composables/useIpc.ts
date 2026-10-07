import type {
  IpcChannel,
  IpcChannelMap,
  IpcResult
} from '@shared/types'
import { IPC_EVENTS } from '@shared/types'

const hasBridge = typeof window !== 'undefined' && Boolean(window.comfyPilot)

/**
 * Strip Vue reactive Proxies / class instances down to plain JSON data.
 * Electron IPC structured-clone rejects Proxies with
 * "An object could not be cloned." — this runs BEFORE the bridge call.
 */
export function toPlainIpcArg<T>(value: T): T {
  if (value === undefined || value === null) return value
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return null as unknown as T
  }
}

/** Error with machine-readable code + optional suggested port (PORT_IN_USE). */
export class ComfyPilotIpcError extends Error {
  code?: string
  suggestedPort?: number
  constructor(message: string, code?: string, suggestedPort?: number) {
    super(message)
    this.name = 'ComfyPilotIpcError'
    this.code = code
    this.suggestedPort = suggestedPort
  }
}

export async function ipc<C extends IpcChannel>(
  channel: C,
  ...args: IpcChannelMap[C]['args']
): Promise<IpcChannelMap[C]['result']> {
  if (!hasBridge) {
    throw new Error('ComfyPilot bridge is unavailable in this environment')
  }
  const plainArgs = args.map((a) => toPlainIpcArg(a)) as IpcChannelMap[C]['args']
  const res = (await window.comfyPilot.invoke(channel, ...plainArgs)) as IpcResult<
    IpcChannelMap[C]['result']
  >
  if (!res.ok) {
    throw new ComfyPilotIpcError(res.error || 'IPC failed', res.code, res.suggestedPort)
  }
  return res.data as IpcChannelMap[C]['result']
}

export function onIpc(event: string, listener: (...args: unknown[]) => void): () => void {
  if (!hasBridge) return () => undefined
  return window.comfyPilot.on(event, listener)
}

export function onInstanceStatus<T>(fn: (info: T) => void): () => void {
  return onIpc(IPC_EVENTS.instanceStatus, (payload) => fn(payload as T))
}

export function onMonitorTick<T>(fn: (snap: T) => void): () => void {
  return onIpc(IPC_EVENTS.monitorTick, (payload) => fn(payload as T))
}

export function onDownloadProgress<T>(fn: (task: T) => void): () => void {
  return onIpc(IPC_EVENTS.downloadProgress, (payload) => fn(payload as T))
}

export function onModelScanProgress<T>(fn: (p: T) => void): () => void {
  return onIpc(IPC_EVENTS.modelScanProgress, (payload) => fn(payload as T))
}

export { IPC_EVENTS }
