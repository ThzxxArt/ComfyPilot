import { monitorService } from '../../services/monitor'
import { isTrustedComfyUrl, wrap } from '../context'

export function createMonitorHandlers() {
  return {
    system: wrap(() => monitorService.systemSnapshot()),
    queue: wrap((baseUrl?: string) => {
      if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.queueSnapshot(baseUrl)
    }),
    series: wrap(() => monitorService.seriesSnapshot()),
    history: wrap((baseUrl?: string) => {
      if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.history(baseUrl)
    }),
    jobs: wrap((baseUrl?: string) => {
      if (baseUrl && !isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.jobsSnapshot(baseUrl)
    }),
    connectWs: wrap((baseUrl: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.connectWs(baseUrl)
    }),
    disconnectWs: wrap(() => {
      monitorService.disconnectWs()
      return true
    }),
    // Runtime operations (0.1.15): same trusted-URL gate as every monitor call;
    // the service re-validates (assertMonitorBaseUrl) and attaches remote auth.
    clearQueue: wrap((baseUrl: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.clearQueue(baseUrl)
    }),
    interrupt: wrap((baseUrl: string, promptId?: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.interrupt(baseUrl, promptId ? String(promptId) : undefined)
    }),
    freeMemory: wrap((baseUrl: string) => {
      if (!isTrustedComfyUrl(baseUrl)) throw new Error('Blocked untrusted monitor URL')
      return monitorService.freeMemory(baseUrl)
    })
  }
}
