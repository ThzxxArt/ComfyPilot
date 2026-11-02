import { doctorService } from '../../services/doctor'
import { wrap } from '../context'
import { requireLocalTarget } from '../trust'

/** 0.1.18 (WP6): one health check at a time, cancellable from the page. */
let doctorAbort: AbortController | null = null

export function createDoctorHandlers() {
  return {
    run: wrap(async (instanceId: string) => {
      if (doctorAbort) {
        const e = new Error('A health check is already running') as Error & { code?: string }
        e.code = 'OP_IN_PROGRESS'
        throw e
      }
      const ac = new AbortController()
      doctorAbort = ac
      try {
        return await doctorService.run(requireLocalTarget(instanceId), { signal: ac.signal })
      } finally {
        if (doctorAbort === ac) doctorAbort = null
      }
    }),
    cancel: wrap(() => {
      if (!doctorAbort) return false
      doctorAbort.abort()
      return true
    }),
    fix: wrap((instanceId: string, fixId: string) =>
      doctorService.fix(requireLocalTarget(instanceId), fixId)
    )
  }
}
