import type { ComfyInstanceConfig } from '@shared/types'
import { readJsonc, upsertInList, writeJsonc } from './jsonc'

// ---------- Instances ----------
export function loadInstanceConfigs(): ComfyInstanceConfig[] {
  return readJsonc<ComfyInstanceConfig[]>('instances', [])
}

export function upsertInstanceConfig(config: ComfyInstanceConfig): void {
  upsertInList('instances', config, (a, b) => a.id === b.id)
}

export function deleteInstanceConfig(id: string): boolean {
  const list = loadInstanceConfigs()
  const next = list.filter((c) => c.id !== id)
  writeJsonc('instances', next, 'ComfyPilot instances')
  return next.length !== list.length
}
