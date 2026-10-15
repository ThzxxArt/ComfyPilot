import { describe, it, expect } from 'vitest'
import { classifyLogLine, stripAnsi, isNoiseLogLine } from '../../src/shared/logLine'

describe('shared/logLine (0.1.16)', () => {
  it('stripAnsi removes colour/control sequences', () => {
    expect(stripAnsi('\u001b[32m[INFO]\u001b[0m setup')).toBe('[INFO] setup')
    expect(stripAnsi('\u001b[1m\u001b[33m[WARNING]\u001b[0m boom')).toBe('[WARNING] boom')
    expect(stripAnsi('no codes here')).toBe('no codes here')
  })

  it('classifyLogLine trusts the line token even on stderr (the core bug)', () => {
    // Python logging writes INFO to stderr — must NOT be painted as a warning.
    expect(classifyLogLine('stderr', '[INFO] plugin ready')).toBe('info')
    expect(classifyLogLine('stderr', '\u001b[32m[INFO]\u001b[0m plugin ready')).toBe('info')
    expect(classifyLogLine('stderr', '[DEBUG] load node')).toBe('debug')
    expect(classifyLogLine('stderr', '[WARNING] slow')).toBe('warn')
    expect(classifyLogLine('stderr', '[ERROR] boom')).toBe('error')
    expect(classifyLogLine('stdout', '[CRITICAL] fatal')).toBe('error')
  })

  it('falls back to severity keywords then stream', () => {
    expect(classifyLogLine('stderr', '!!! Exception during processing !!!')).toBe('error')
    expect(classifyLogLine('stdout', 'Traceback (most recent call last):')).toBe('error')
    expect(classifyLogLine('stdout', 'ModuleNotFoundError: No module named x')).toBe('error')
    expect(classifyLogLine('stdout', 'a warning about caches')).toBe('warn')
    expect(classifyLogLine('stdout', 'plain chatter')).toBe('info')
    expect(classifyLogLine('stderr', 'plain diagnostics')).toBe('warn')
  })

  it('isNoiseLogLine hides debug + known startup chatter by default', () => {
    expect(isNoiseLogLine('debug', 'anything')).toBe(true)
    expect(isNoiseLogLine('info', 'Trying to load custom node D:/x')).toBe(true)
    expect(
      isNoiseLogLine('info', '\u001b[36m[DEBUG]\u001b[0m recursive file list on directory D:/x')
    ).toBe(true)
    expect(isNoiseLogLine('info', 'ComfyUI ready at http://127.0.0.1:8188')).toBe(false)
    expect(isNoiseLogLine('warn', '[WARNING] On windows we are forcing single GPU')).toBe(false)
  })
})
