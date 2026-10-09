import { describe, it, expect, vi, beforeEach } from 'vitest'

type LstatResult = {
  isSymbolicLink: () => boolean
  isDirectory: () => boolean
}

const state = vi.hoisted(() => {
  const exec = {
    platform: 'win32' as string,
    listStdout: 'ok.txt\n',
    unzipFails: false,
    extractCmds: [] as string[]
  }
  const fs = {
    /** readdirSync by directory path; default used when path not listed */
    entriesByPath: new Map<string, string[]>(),
    defaultEntries: ['ok.txt'] as string[],
    lstatByPath: new Map<string, LstatResult | Error>(),
    defaultLstat: null as LstatResult | Error | null,
    realPathByPath: new Map<string, string>(),
    realpathFails: false,
    rmThrows: false
  }
  return { exec, fs }
})

vi.mock('child_process', async () => {
  const util = await import('util')
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
        (cmd.includes('powershell') && args.some((a) => String(a).includes('ZipFile') && !String(a).includes('Extract'))))
    const isExtract =
      Array.isArray(args) &&
      (args.includes('-o') ||
        args.some((a) => String(a).includes('ExtractToDirectory') || String(a).includes('Expand-Archive')))

    if (isList && state.exec.unzipFails && args.includes('-Z1')) {
      const err = new Error('unzip missing') as Error & { code?: number }
      err.code = 127
      if (cb) {
        cb(err, '', 'unzip missing')
        return { on: () => undefined, kill: () => undefined }
      }
      return Promise.reject(err)
    }

    if (isExtract) state.exec.extractCmds.push(`${cmd} ${args.join(' ')}`)

    const stdout = isList ? state.exec.listStdout : ''
    if (cb) {
      cb(null, stdout, '')
      return { on: () => undefined, kill: () => undefined }
    }
    return Promise.resolve({ stdout, stderr: '' })
  }

  ;(fakeExecFile as unknown as Record<symbol, unknown>)[util.promisify.custom] = async (
    cmd: string,
    args: string[]
  ) => {
    const isList =
      Array.isArray(args) &&
      (args.includes('-Z1') ||
        args.includes('-1') ||
        args.some((a) => String(a).includes('ZipFile') && !String(a).includes('Extract')))
    const isExtract =
      Array.isArray(args) &&
      (args.includes('-o') ||
        args.some((a) => String(a).includes('ExtractToDirectory') || String(a).includes('Expand-Archive')))
    if (isList && state.exec.unzipFails && args.includes('-Z1')) {
      const err = new Error('unzip missing') as Error & { code?: number }
      err.code = 127
      throw err
    }
    if (isExtract) state.exec.extractCmds.push(`${cmd} ${args.join(' ')}`)
    return { stdout: isList ? state.exec.listStdout : '', stderr: '' }
  }

  return { execFile: fakeExecFile }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  // join()/resolve() on win32 produce backslashes; normalize so test keys match
  const norm = (p: string) => String(p).replace(/\\/g, '/').toLowerCase()
  return {
    ...actual,
    existsSync: () => true,
    readdirSync: (p: string) => {
      const listed = state.fs.entriesByPath.get(norm(p))
      return (listed ?? state.fs.defaultEntries).slice()
    },
    lstatSync: (p: string) => {
      const custom = state.fs.lstatByPath.get(norm(p))
      const value = custom ?? state.fs.defaultLstat
      if (value instanceof Error) throw value
      if (value) return value
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    },
    realpathSync: (p: string) => {
      if (state.fs.realpathFails) throw new Error('realpath fail')
      return state.fs.realPathByPath.get(norm(p)) ?? p
    },
    rmSync: () => {
      if (state.fs.rmThrows) throw new Error('rm fail')
    }
  }
})

import {
  findZipSlipEntry,
  listZipEntries,
  assertZipSafe,
  safeUnzip,
  joinInside
} from '../../src/main/services/zipSafe'

function fileStat(): LstatResult {
  return { isSymbolicLink: () => false, isDirectory: () => false }
}
function dirStat(): LstatResult {
  return { isSymbolicLink: () => false, isDirectory: () => true }
}
function linkStat(): LstatResult {
  return { isSymbolicLink: () => true, isDirectory: () => false }
}

beforeEach(() => {
  state.exec.platform = 'win32'
  state.exec.listStdout = 'ok.txt\n'
  state.exec.unzipFails = false
  state.exec.extractCmds = []
  state.fs.entriesByPath.clear()
  state.fs.defaultEntries = ['ok.txt']
  state.fs.lstatByPath.clear()
  state.fs.defaultLstat = null
  state.fs.realPathByPath.clear()
  state.fs.realpathFails = false
  state.fs.rmThrows = false
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
})

describe('findZipSlipEntry residual branches', () => {
  it('ignores blank entries and flags embedded-dot hops after normalize', () => {
    expect(findZipSlipEntry(['', 'ok.txt'])).toBeNull()
    // `x..y` is not a raw `..` hop and survives segment normalize,
    // but normalizePathEverySegment turns it into a parent hop.
    expect(findZipSlipEntry(['foo/x..y/bar'])).toBeTruthy()
    expect(findZipSlipEntry(['a..b'])).toBeTruthy()
  })

  it('treats trailing directory separators as empty and safe', () => {
    expect(findZipSlipEntry(['dir/', 'dir//', 'ok/nested/'])).toBeNull()
    // Leading-dot segments are LEGITIMATE (.ci / .github / .hidden) — Win32 only
    // strips trailing dots/spaces. Rejecting them broke ComfyUI-master/.ci/.
    expect(findZipSlipEntry(['.hidden'])).toBeNull()
    expect(findZipSlipEntry(['ComfyUI-master/.ci/'])).toBeNull()
    expect(findZipSlipEntry(['ComfyUI-master/.github/workflows/ci.yml'])).toBeNull()
    expect(findZipSlipEntry(['././ok.txt'])).toBeNull()
  })
})

describe('listZipEntries non-win32', () => {
  it('uses unzip -Z1 when available', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    state.exec.listStdout = 'a.txt\n b.txt \n\n'
    await expect(listZipEntries('z.zip')).resolves.toEqual(['a.txt', 'b.txt'])
  })

  it('falls back to zipinfo when unzip is missing', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    state.exec.unzipFails = true
    state.exec.listStdout = 'fallback.txt\n'
    await expect(listZipEntries('z.zip')).resolves.toEqual(['fallback.txt'])
  })

  it('lists entries on win32 and escapes embedded quotes', async () => {
    state.exec.listStdout = 'a.txt\r\nb.txt\r\n'
    await expect(listZipEntries("C:\\zips\\it's.zip")).resolves.toEqual(['a.txt', 'b.txt'])
    await expect(assertZipSafe('clean.zip')).resolves.toBeUndefined()
  })
})

describe('safeUnzip post-check containment', () => {
  it('rejects entries that escape the destination and cleans up', async () => {
    state.fs.defaultEntries = ['../evil.txt']
    await expect(safeUnzip('z.zip', '/tmp/dest')).rejects.toThrow(/escaped/i)
  })

  it('rejects symlinked entries', async () => {
    state.fs.defaultLstat = linkStat()
    await expect(safeUnzip('z.zip', '/tmp/dest')).rejects.toThrow(/symlink/i)
  })

  it('accepts plain files and walks nested directories', async () => {
    state.fs.defaultLstat = fileStat()
    await expect(safeUnzip('z.zip', '/tmp/dest')).resolves.toBeUndefined()

    state.fs.defaultEntries = ['sub']
    state.fs.entriesByPath.set('/tmp/dest', ['sub'])
    state.fs.entriesByPath.set('/tmp/dest/sub', ['ok.txt'])
    state.fs.lstatByPath.set('/tmp/dest/sub', dirStat())
    state.fs.lstatByPath.set('/tmp/dest/sub/ok.txt', fileStat())
    await expect(safeUnzip('z.zip', '/tmp/dest')).resolves.toBeUndefined()
  })

  it('skips already-visited real directories', async () => {
    state.fs.entriesByPath.set('/tmp/dest', ['sub', 'other'])
    state.fs.entriesByPath.set('/tmp/dest/sub', ['ok.txt'])
    state.fs.entriesByPath.set('/tmp/dest/other', [])
    state.fs.lstatByPath.set('/tmp/dest/sub', dirStat())
    state.fs.lstatByPath.set('/tmp/dest/other', dirStat())
    state.fs.lstatByPath.set('/tmp/dest/sub/ok.txt', fileStat())
    // both dirs report the same real path → second is skipped
    state.fs.realPathByPath.set('/tmp/dest/sub', '/tmp/dest/real-dir')
    state.fs.realPathByPath.set('/tmp/dest/other', '/tmp/dest/real-dir')
    await expect(safeUnzip('z.zip', '/tmp/dest')).resolves.toBeUndefined()
  })

  it('skips paths that vanish mid-walk', async () => {
    state.fs.defaultEntries = ['gone.txt', 'ok.txt']
    state.fs.defaultLstat = new Error('ENOENT')
    state.fs.lstatByPath.set('/tmp/dest/ok.txt', fileStat())
    await expect(safeUnzip('z.zip', '/tmp/dest')).resolves.toBeUndefined()
  })

  it('ignores cleanup failures when blocking an escape', async () => {
    state.fs.defaultEntries = ['../evil.txt']
    state.fs.rmThrows = true
    await expect(safeUnzip('z.zip', '/tmp/dest')).rejects.toThrow(/escaped/i)

    state.fs.defaultEntries = ['lnk']
    state.fs.defaultLstat = linkStat()
    await expect(safeUnzip('z.zip', '/tmp/dest')).rejects.toThrow(/symlink/i)
  })

  it('still resolves when realpath fails while marking directories', async () => {
    state.fs.defaultEntries = []
    state.fs.defaultLstat = null
    state.fs.entriesByPath.set('/tmp/dest', ['sub'])
    state.fs.entriesByPath.set('/tmp/dest/sub', [])
    state.fs.lstatByPath.set('/tmp/dest/sub', dirStat())
    state.fs.realpathFails = true
    await expect(safeUnzip('z.zip', '/tmp/dest')).resolves.toBeUndefined()
  })

  it('extracts via unzip on non-win32', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    state.fs.defaultLstat = fileStat()
    await expect(safeUnzip('z.zip', '/tmp/dest')).resolves.toBeUndefined()
    expect(state.exec.extractCmds.join(' ')).toContain('unzip')
    expect(state.exec.extractCmds.join(' ')).toContain('-d')
  })
})

describe('joinInside', () => {
  it('returns a normalized path under root', () => {
    // Use a root form that is absolute on BOTH host platforms so the test
    // does not depend on how path.resolve treats drive letters on POSIX.
    const root = process.platform === 'win32' ? 'C:\\tmp\\root' : '/tmp/root'
    const target = joinInside(root, 'a', 'b.txt')
    expect(target.toLowerCase()).toContain('b.txt')
    // The joined path must sit under the root — compare on the same
    // normalization isPathInside uses.
    const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase()
    expect(norm(target).startsWith(norm(root).replace(/\/+$/, '') + '/')).toBe(true)
  })

  it('throws when parts escape root', () => {
    const root = process.platform === 'win32' ? 'C:\\tmp\\root' : '/tmp/root'
    expect(() => joinInside(root, '..', 'etc')).toThrow(/escapes/i)
    expect(() => joinInside(root, 'x/../../etc')).toThrow(/escapes/i)
  })
})
