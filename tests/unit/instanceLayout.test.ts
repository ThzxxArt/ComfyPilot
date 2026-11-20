import { describe, it, expect } from 'vitest'
import {
  buildEffectiveArgList,
  isManagerEnabledInArgv,
  joinPathLike,
  probeHostForListen,
  readLastFlagValue,
  resolveEffectiveDirs,
  resolveEffectiveInstance,
  resolveEffectiveListen,
  resolveEffectivePort
} from '@shared/instanceLayout'
import type { ComfyInstanceConfig } from '@shared/types'

function cfg(patch: Partial<ComfyInstanceConfig> = {}): ComfyInstanceConfig {
  return {
    id: 'i1',
    name: 'test',
    path: '/opt/ComfyUI',
    pythonPath: '',
    venvPath: '',
    port: 8188,
    listen: '127.0.0.1',
    extraArgs: [],
    argTemplateId: 'default',
    enabled: true,
    notes: '',
    autoStart: false,
    frontendVersion: '',
    pinned: false,
    ...patch
  }
}

describe('instance effective layout (0.2.5 WP1)', () => {
  it('derives the default ComfyUI tree from the instance root', () => {
    const e = resolveEffectiveInstance(cfg())
    expect(e.port).toBe(8188)
    expect(e.listen).toBe('127.0.0.1')
    expect(e.probeHost).toBe('127.0.0.1')
    expect(e.url).toBe('http://127.0.0.1:8188')
    expect(e.dirs).toEqual({
      base: '/opt/ComfyUI',
      user: '/opt/ComfyUI/user',
      models: '/opt/ComfyUI/models',
      customNodes: '/opt/ComfyUI/custom_nodes',
      input: '/opt/ComfyUI/input',
      output: '/opt/ComfyUI/output',
      temp: '/opt/ComfyUI/temp',
      previews: '/opt/ComfyUI/previews',
      workflows: '/opt/ComfyUI/user/default/workflows',
      manager: '/opt/ComfyUI/user/__manager'
    })
  })

  it('honours every directory flag and --base-directory as the new root', () => {
    const e = resolveEffectiveInstance(
      cfg({
        extraArgs: [
          '--base-directory',
          '/data/base',
          '--user-directory',
          '/data/user',
          '--models-directory',
          '/data/models',
          '--input-directory',
          '/data/input',
          '--output-directory',
          '/data/output',
          '--temp-directory',
          '/data/temp',
          '--previews-directory',
          '/data/previews'
        ]
      })
    )
    expect(e.dirs.base).toBe('/data/base')
    expect(e.dirs.user).toBe('/data/user')
    expect(e.dirs.models).toBe('/data/models')
    expect(e.dirs.customNodes).toBe('/data/base/custom_nodes')
    expect(e.dirs.input).toBe('/data/input')
    expect(e.dirs.output).toBe('/data/output')
    expect(e.dirs.temp).toBe('/data/temp')
    expect(e.dirs.previews).toBe('/data/previews')
    expect(e.dirs.workflows).toBe('/data/user/default/workflows')
    expect(e.dirs.manager).toBe('/data/user/__manager')
  })

  it('reads structured launchProfile directories, with extraArgs still winning', () => {
    const e = resolveEffectiveInstance(
      cfg({
        launchProfile: {
          baseDirectory: '/structured/base',
          modelsDirectory: '/structured/models',
          outputDirectory: '/structured/output'
        },
        extraArgs: ['--output-directory=/override/out']
      })
    )
    expect(e.dirs.base).toBe('/structured/base')
    expect(e.dirs.models).toBe('/structured/models')
    expect(e.dirs.output).toBe('/override/out')
  })

  it('resolves relative directories against the instance root', () => {
    const e = resolveEffectiveInstance(
      cfg({ extraArgs: ['--base-directory', 'shared/base', '--user-directory', 'my-user'] })
    )
    expect(e.dirs.base).toBe('/opt/ComfyUI/shared/base')
    expect(e.dirs.user).toBe('/opt/ComfyUI/shared/base/my-user')
    expect(e.dirs.customNodes).toBe('/opt/ComfyUI/shared/base/custom_nodes')
  })

  it('takes the LAST --port, supports = form and ignores an invalid tail value', () => {
    expect(resolveEffectivePort(cfg({ extraArgs: ['--port', '9000', '--port=9999'] }))).toBe(9999)
    expect(resolveEffectivePort(cfg({ extraArgs: ['--port=9999', '--port', '9000'] }))).toBe(9000)
    expect(resolveEffectivePort(cfg({ extraArgs: ['--port', '9999', '--port'] }))).toBe(9999)
    expect(resolveEffectivePort(cfg({ extraArgs: ['--port=0'] }))).toBe(8188)
    expect(resolveEffectivePort(cfg({ extraArgs: ['--port=not-a-port'] }))).toBe(8188)
  })

  it('supports comma-separated listen lists and IPv6 probe URLs', () => {
    expect(probeHostForListen('0.0.0.0,::')).toBe('127.0.0.1')
    expect(probeHostForListen('[::]')).toBe('127.0.0.1')
    expect(probeHostForListen('192.168.1.5,127.0.0.1')).toBe('127.0.0.1')
    expect(probeHostForListen('192.168.1.5,10.0.0.2')).toBe('192.168.1.5')
    const e = resolveEffectiveInstance(cfg({ extraArgs: ['--listen', '::1,127.0.0.1'] }))
    expect(e.listen).toBe('::1,127.0.0.1')
    expect(e.probeHost).toBe('127.0.0.1')

    const v6 = resolveEffectiveInstance(cfg({ listen: '::1', port: 9000 }))
    expect(v6.url).toBe('http://[::1]:9000')
  })

  it('lets a LAN template override the configured listen (last one wins)', () => {
    const e = resolveEffectiveInstance(cfg({ argTemplateId: 'lan' }))
    expect(e.listen).toBe('0.0.0.0')
    expect(e.probeHost).toBe('127.0.0.1')
    const override = resolveEffectiveInstance(
      cfg({ argTemplateId: 'lan', extraArgs: ['--listen', '127.0.0.1'] })
    )
    expect(override.listen).toBe('127.0.0.1')
  })

  it('handles Windows drive paths without host-OS semantics', () => {
    const e = resolveEffectiveInstance(
      cfg({
        path: 'D:\\AI\\ComfyUI',
        extraArgs: ['--base-directory', 'E:\\CP\\base', '--models-directory', 'models-shared']
      })
    )
    expect(e.dirs.base).toBe('E:\\CP\\base')
    expect(e.dirs.models).toBe('E:\\CP\\base\\models-shared')
    expect(e.dirs.customNodes).toBe('E:\\CP\\base\\custom_nodes')
    expect(e.dirs.workflows).toBe('E:\\CP\\base\\user\\default\\workflows')
  })

  it('collapses . and .. lexically instead of leaving traversal segments', () => {
    expect(joinPathLike('/opt/ComfyUI', './a/../b')).toBe('/opt/ComfyUI/b')
    expect(joinPathLike('/opt/ComfyUI', '../shared')).toBe('/opt/shared')
    expect(joinPathLike('D:\\AI\\ComfyUI', '..\\shared')).toBe('D:\\AI\\shared')
  })

  it('extracts flag values from = and space forms', () => {
    const args = ['--port', '8188', '--port=9000', '--listen=0.0.0.0', '--listen', '::']
    expect(readLastFlagValue(args, '--port')).toBe('9000')
    expect(readLastFlagValue(args, '--listen')).toBe('::')
    expect(readLastFlagValue(args, '--missing')).toBeUndefined()
  })

  it('reports Manager enabled from template, profile or extraArgs', () => {
    expect(isManagerEnabledInArgv(cfg({ argTemplateId: 'manager' }))).toBe(true)
    expect(isManagerEnabledInArgv(cfg({ extraArgs: ['--enable-manager'] }))).toBe(true)
    expect(isManagerEnabledInArgv(cfg({ extraArgs: ['--enable-manager-ui'] }))).toBe(false)
    expect(isManagerEnabledInArgv(cfg())).toBe(false)
  })

  it('keeps the effective argv prefix in buildArgs order', () => {
    const args = buildEffectiveArgList(
      cfg({ port: 8188, listen: '127.0.0.1', extraArgs: ['--port', '9999'] })
    )
    expect(args.slice(0, 4)).toEqual(['--port', '8188', '--listen', '127.0.0.1'])
    expect(args.slice(-2)).toEqual(['--port', '9999'])
  })

  it('negative: an empty --listen/--port value falls back, never becomes URL garbage', () => {
    expect(resolveEffectiveListen(cfg({ extraArgs: ['--listen', ''] }))).toBe('127.0.0.1')
    expect(resolveEffectiveListen(cfg({ extraArgs: ['--listen='] }))).toBe('127.0.0.1')
    const e = resolveEffectiveInstance(cfg({ extraArgs: ['--listen', ' , '] }))
    expect(e.probeHost).toBe('127.0.0.1')
  })
})
