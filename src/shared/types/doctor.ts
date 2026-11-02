/** Shared doctor/health-check types. */

// ---------- Doctor ----------
export type DoctorSeverity = 'pass' | 'warn' | 'fail' | 'info'

export interface DoctorCheck {
  id: string
  group: string
  title: string
  severity: DoctorSeverity
  detail: string
  suggestion?: string
  fixable: boolean
  fixId?: string
}

export interface DoctorReport {
  id: string
  instanceId: string
  createdAt: number
  durationMs: number
  checks: DoctorCheck[]
  summary: { pass: number; warn: number; fail: number; info: number }
}
