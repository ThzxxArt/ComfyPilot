/**
 * JS-side design tokens — keep in lockstep with variables.scss.
 * Use these for inline styles / Naive props that cannot read SCSS variables.
 */
export const COLORS = {
  primary: '#4F6EF7',
  primaryHover: '#6B84F9',
  primaryPressed: '#3D5AE0',
  primary2: '#7C5CFC',
  accent: '#22D3EE',
  success: '#10B981',
  successInk: '#059669',
  warning: '#F59E0B',
  warningInk: '#B45309',
  danger: '#EF4444',
  dangerInk: '#B91C1C',
  mutedInk: '#64748B',
  text: '#0F172A',
  textSecondary: '#475569',
  textMuted: '#94A3B8',
  white: '#FFFFFF'
} as const

export type ColorToken = keyof typeof COLORS

/** Severity → ink color (for status numbers, check marks, etc.) */
export function severityColor(severity: 'pass' | 'ok' | 'success' | 'warn' | 'warning' | 'fail' | 'error' | 'info' | 'muted'): string {
  switch (severity) {
    case 'pass':
    case 'ok':
    case 'success':
      return COLORS.successInk
    case 'warn':
    case 'warning':
    case 'info':
      return COLORS.warningInk
    case 'fail':
    case 'error':
      return COLORS.dangerInk
    default:
      return COLORS.mutedInk
  }
}
