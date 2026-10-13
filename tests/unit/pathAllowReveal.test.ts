/**
 * Path allow-list gate used by `shell.reveal` and `output.list` root checks.
 * 0.1.9 replaced lexical prefix checks with `resolveInsideAnyRoot`, which
 * normalizes per segment and resolves `..` — these are the behavior tests.
 */
import { describe, expect, it } from 'vitest'
import { join, sep } from 'path'
import { tmpdir } from 'os'
import { resolveInsideAnyRoot } from '../../src/main/services/security'

const ROOT_A = join(tmpdir(), 'cp-allow-a')
const ROOT_B = join(tmpdir(), 'cp-allow-b')

describe('resolveInsideAnyRoot (reveal / output-root gate)', () => {
  it('accepts roots and paths inside them', () => {
    expect(resolveInsideAnyRoot(ROOT_A, [ROOT_A])).toBe(ROOT_A)
    expect(resolveInsideAnyRoot(join(ROOT_A, 'output', 'x.png'), [ROOT_A])).toBe(
      join(ROOT_A, 'output', 'x.png')
    )
    expect(resolveInsideAnyRoot(join(ROOT_B, 'x'), [ROOT_A, ROOT_B])).toBe(join(ROOT_B, 'x'))
  })

  it('rejects outside paths', () => {
    expect(resolveInsideAnyRoot(join(tmpdir(), 'elsewhere', 'x'), [ROOT_A, ROOT_B])).toBeNull()
  })

  it('rejects `..` escapes even when the lexical prefix matches', () => {
    // The old isPathInside-only check accepted this (lexical prefix); the
    // per-segment normalizer must refuse it.
    expect(resolveInsideAnyRoot(join(ROOT_A, '..', 'cp-allow-b', 'secret'), [ROOT_A])).toBeNull()
    expect(resolveInsideAnyRoot(`${ROOT_A}${sep}..${sep}..${sep}etc`, [ROOT_A])).toBeNull()
  })

  it('rejects Windows trailing-dot/space hop variants (`.. ` / `... `)', () => {
    // Win32 strips trailing dots/spaces, so these collapse onto the parent.
    expect(resolveInsideAnyRoot(`${ROOT_A}${sep}output${sep}.. `, [ROOT_A])).toBeNull()
    expect(resolveInsideAnyRoot(`${ROOT_A}${sep}output${sep}... `, [ROOT_A])).toBeNull()
    expect(resolveInsideAnyRoot(`${ROOT_A}${sep}output${sep}...`, [ROOT_A])).toBeNull()
  })

  it('allows ordinary names containing dots (regression: `a..b`)', () => {
    expect(resolveInsideAnyRoot(join(ROOT_A, 'a..b.png'), [ROOT_A])).toBe(join(ROOT_A, 'a..b.png'))
    expect(resolveInsideAnyRoot(join(ROOT_A, 'x..y', 'z.txt'), [ROOT_A])).toBe(
      join(ROOT_A, 'x..y', 'z.txt')
    )
  })

  it('rejects empty/garbage input', () => {
    expect(resolveInsideAnyRoot('', [ROOT_A])).toBeNull()
    expect(resolveInsideAnyRoot('\0bad', [ROOT_A])).toBeNull()
  })
})
