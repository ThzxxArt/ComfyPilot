import { describe, it, expect } from 'vitest'
import { LruCache } from '../../src/main/services/lru'

describe('LruCache (0.1.16)', () => {
  it('evicts the least-recently-used entry past capacity', () => {
    const c = new LruCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.get('a')).toBe(1) // refresh a
    c.set('c', 3) // evicts b
    expect(c.has('b')).toBe(false)
    expect(c.get('a')).toBe(1)
    expect(c.get('c')).toBe(3)
  })

  it('set refreshes recency and updates values', () => {
    const c = new LruCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 10) // refresh + update
    c.set('c', 3) // evicts b
    expect(c.get('a')).toBe(10)
    expect(c.has('b')).toBe(false)
  })

  it('supports delete/clear/size and peek without refresh', () => {
    const c = new LruCache<string, number>(3)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.peek('a')).toBe(1)
    expect(c.size).toBe(2)
    expect(c.delete('a')).toBe(true)
    c.clear()
    expect(c.size).toBe(0)
  })

  it('rejects invalid capacity', () => {
    expect(() => new LruCache<string, number>(0)).toThrow()
  })
})
