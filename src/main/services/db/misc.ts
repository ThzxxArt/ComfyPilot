import { randomUUID } from 'crypto'
import { readdirSync } from 'fs'
import { userDataDir } from './paths'

export function newId(): string {
  return randomUUID()
}

/** List jsonc config files for UI/debug. */
export function listConfigFiles(): string[] {
  try {
    return readdirSync(userDataDir()).filter((f) => f.endsWith('.jsonc'))
  } catch {
    return []
  }
}
