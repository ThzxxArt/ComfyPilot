import { describe, expect, it } from 'vitest'
import { formatArgv, parseArgv, splitFlagArg } from '../../src/shared/argv'

describe('parseArgv (0.2.0 custom launch arguments)', () => {
  it('keeps quoted paths with spaces as one token', () => {
    const parsed = parseArgv('--base-directory "D:\\\\My Models" --preview-method taesd')
    expect(parsed.errors).toEqual([])
    expect(parsed.tokens).toEqual([
      '--base-directory',
      'D:\\My Models',
      '--preview-method',
      'taesd'
    ])
  })

  it('supports single quotes, escaped quotes and --flag=value', () => {
    const parsed = parseArgv(`--output-directory='D:/out dir' --name="a \\"b\\"" --vram=0.5`)
    expect(parsed.errors).toEqual([])
    expect(parsed.tokens).toEqual(['--output-directory=D:/out dir', '--name=a "b"', '--vram=0.5'])
    expect(splitFlagArg(parsed.tokens[0])).toEqual({
      flag: '--output-directory',
      value: 'D:/out dir'
    })
  })

  it('reports an unclosed quote instead of silently truncating', () => {
    const parsed = parseArgv('--path "D:/unfinished')
    expect(parsed.errors[0]).toContain('unclosed')
  })

  it('round-trips through formatArgv', () => {
    const tokens = ['--base-directory', 'D:\\My Models', '--name', 'a "b"']
    expect(parseArgv(formatArgv(tokens)).tokens).toEqual(tokens)
  })

  it('keeps backslashes literal outside quotes (Windows paths)', () => {
    expect(parseArgv('--models-directory D:\\AI\\models').tokens).toEqual([
      '--models-directory',
      'D:\\AI\\models'
    ])
  })
})
