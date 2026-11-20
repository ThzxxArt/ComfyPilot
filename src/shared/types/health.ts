/** Instance health facts and recovery policy (0.2.5 WP2/WP3). */

export type HealthState =
  | 'unknown'
  | 'healthy'
  | 'busy'
  | 'suspect'
  | 'unresponsive'
  | 'crashed'
  | 'stopped'

export interface InstanceHealth {
  instanceId: string
  state: HealthState
  checkedAt: number
  /** When the current state began (ms epoch). */
  since: number
  latencyMs?: number
  consecutiveFailures: number
  lastOkAt?: number
  lastLogAt?: number
  lastProgressAt?: number
  queueRunning: number
  queuePending: number
  portListening: boolean
  processAlive: boolean
  processCpu?: number
  gpuUtilization?: number
  evidence: string[]
  message?: string
}

export interface HealthRecoveryPolicy {
  /** Default false: 0.2.5 only warns unless the user explicitly opts in. */
  enabled: boolean
  action: 'restart' | 'safe-restart'
  /** unresponsive must persist this long before acting. Default 60s. */
  afterMs: number
  /** Max attempts in the 10-minute circuit window. Default 3. */
  maxAttempts: number
  /** Minimum gap between attempts. Default 5 min. */
  cooldownMs: number
  /** Never kill an instance with running jobs unless explicitly true. */
  killRunningJobs: boolean
}

export const DEFAULT_HEALTH_RECOVERY_POLICY: HealthRecoveryPolicy = {
  enabled: false,
  action: 'restart',
  afterMs: 60_000,
  maxAttempts: 3,
  cooldownMs: 300_000,
  killRunningJobs: false
}
