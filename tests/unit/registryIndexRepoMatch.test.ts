/**
 * registryIndex repository-URL matching (0.1.9): canonicalization across
 * https / scp-style ssh / git+ / trailing .git / trailing slash, plus the
 * catalog lookup used by update checks for manually cloned packs.
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'cp-regidx-test') }
}))

import { registryIndex, normalizeRepositoryUrl } from '../../src/main/services/registryIndex'

describe('normalizeRepositoryUrl', () => {
  it('canonicalizes every common git URL spelling', () => {
    expect(normalizeRepositoryUrl('git@github.com:Org/Repo.git')).toBe(
      'https://github.com/org/repo'
    )
    expect(normalizeRepositoryUrl('https://GitHub.com/Org/Repo.git/')).toBe(
      'https://github.com/org/repo'
    )
    expect(normalizeRepositoryUrl('ssh://git@github.com/org/repo')).toBe(
      'https://github.com/org/repo'
    )
    expect(normalizeRepositoryUrl('git+https://github.com/org/repo')).toBe(
      'https://github.com/org/repo'
    )
    expect(normalizeRepositoryUrl('https://github.com/org/repo/')).toBe(
      'https://github.com/org/repo'
    )
    expect(normalizeRepositoryUrl('')).toBe('')
  })
})

describe('registryIndex.findByRepository', () => {
  it('matches catalog items across URL spellings', () => {
    const idx = registryIndex as unknown as { items: Array<Record<string, unknown>> | null }
    const prev = idx.items
    idx.items = [
      {
        id: 'x',
        name: 'X',
        repository: 'https://github.com/Org/Repo',
        latest_version: { version: '2.0.0' }
      }
    ]
    try {
      const hit = registryIndex.findByRepository('git@github.com:Org/Repo.git')
      expect(hit?.id).toBe('x')
      expect(hit?.latestVersion).toBe('2.0.0')
      expect(registryIndex.findByRepository('')).toBeNull()
      expect(registryIndex.findByRepository('https://github.com/other/none')).toBeNull()
    } finally {
      idx.items = prev
    }
  })
})
