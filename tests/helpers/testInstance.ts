/**
 * Shared test fixture: register a ComfyUI instance so importFile/prepareFrontend
 * have a real `user/default/workflows` target.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'

export interface SeedInstanceOpts {
  id?: string
  name?: string
  path: string
  port?: number
  listen?: string
}

export async function seedTestInstance(opts: SeedInstanceOpts): Promise<string> {
  const { upsertInstanceConfig } = await import('../../src/main/services/db')
  const id = opts.id || 'test-inst'
  upsertInstanceConfig({
    id,
    name: opts.name || 'Test Instance',
    path: opts.path,
    pythonPath: '',
    venvPath: '',
    port: opts.port ?? 8188,
    listen: opts.listen ?? '127.0.0.1',
    extraArgs: [],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false
  })
  mkdirSync(join(opts.path, 'user', 'default', 'workflows'), { recursive: true })
  return id
}
