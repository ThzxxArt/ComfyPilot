import { describe, it, expect } from 'vitest'
import { clampPercent, formatPercent, formatBytes, formatUptime, formatSpeed } from '../../src/renderer/src/utils/format'

describe('format helpers', () => {
  it('clampPercent rounds to integer and clamps 0-100', () => {
    expect(clampPercent(14.285714285714286)).toBe(14)
    expect(clampPercent(0.4)).toBe(0)
    expect(clampPercent(0.6)).toBe(1)
    expect(clampPercent(-3)).toBe(0)
    expect(clampPercent(120)).toBe(100)
    expect(clampPercent(Number.NaN)).toBe(0)
  })

  it('formatPercent never prints a long decimal tail', () => {
    expect(formatPercent(14.285714285714286)).toBe('14%')
    expect(formatPercent(100 / 3)).toBe('33%')
    expect(formatPercent(12.34, 1)).toBe('12.3%')
    expect(formatPercent(12.34, 1)).not.toMatch(/\.\d{2,}/)
  })

  it('formatBytes keeps at most one decimal', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024)).toBe('20 KB')
    expect(formatBytes(16376 * 1024 * 1024)).toBe('16 GB')
  })

  it('formatUptime is human-readable', () => {
    expect(formatUptime(42_000)).toBe('42s')
    expect(formatUptime(5 * 60_000 + 3_000)).toBe('5m 3s')
    expect(formatUptime(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m')
    expect(formatUptime(0)).toBe('0s')
  })

  it('formatSpeed', () => {
    expect(formatSpeed(0)).toBe('—')
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s')
  })
})
