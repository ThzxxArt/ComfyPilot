import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fakeExecFile, listState } = vi.hoisted(() => {
  const listState = { stdout: 'ComfyUI/main.py\n' }
  type Cb = (err: Error | null, stdout: string, stderr: string) => void

  function fakeExecFile(
    cmd: string,
    args: string[],
    optsOrCb?: unknown,
    cbMaybe?: unknown
  ): unknown {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : cbMaybe) as Cb | undefined
    const isList =
      Array.isArray(args) &&
      (args.includes('-Z1') ||
        args.includes('-1') ||
        (cmd.includes('powershell') && args.some((a) => String(a).includes('ZipFile'))))
    const stdout = isList ? listState.stdout : ''
    if (cb) {
      cb(null, stdout, '')
      return { on: () => undefined, kill: () => undefined }
    }
    return Promise.resolve({ stdout, stderr: '' })
  }

  // Must match Node's execFile custom promisify shape {stdout,stderr}
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const util = require('util') as typeof import('util')
  ;(fakeExecFile as unknown as Record<symbol, unknown>)[util.promisify.custom] = async (
    _cmd: string,
    args: string[]
  ) => {
    const isList =
      Array.isArray(args) &&
      (args.includes('-Z1') ||
        args.includes('-1') ||
        args.some((a) => String(a).includes('ZipFile')))
    return { stdout: isList ? listState.stdout : '', stderr: '' }
  }

  return { fakeExecFile, listState }
})

vi.mock('child_process', () => ({ execFile: fakeExecFile }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: () => true,
    readdirSync: () => ['main.py'],
    statSync: () => ({ isDirectory: () => false }),
    rmSync: () => undefined
  }
})

import { findZipSlipEntry, assertZipSafe, safeUnzip } from '../../src/main/services/zipSafe'

describe('zipSafe with mocked exec', () => {
  beforeEach(() => {
    listState.stdout = 'ComfyUI/main.py\n'
  })

  it('assertZipSafe rejects bad entries', async () => {
    listState.stdout = '../evil.py\n'
    await expect(assertZipSafe('x.zip')).rejects.toThrow(/Zip-slip/i)
  })

  it('assertZipSafe passes clean archive', async () => {
    await expect(assertZipSafe('x.zip')).resolves.toBeUndefined()
  })

  it('safeUnzip extracts when entries are safe', async () => {
    await expect(safeUnzip('x.zip', '/tmp/dest-zip')).resolves.toBeUndefined()
  })

  it('findZipSlipEntry pure cases', () => {
    expect(findZipSlipEntry(['ok.txt'])).toBeNull()
    expect(findZipSlipEntry(['../x'])).toBeTruthy()
  })
})
