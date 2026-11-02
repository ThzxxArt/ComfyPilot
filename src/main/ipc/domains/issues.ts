import { IPC_EVENTS } from '@shared/types'
import { sanitizeId } from '../../services/security'
import { broadcast, wrap } from '../context'

export function createIssueHandlers() {
  return {
    list: wrap(async (includeResolved?: boolean) => {
      const { issueHubService } = await import('../../services/issueHub')
      return issueHubService.list(Boolean(includeResolved))
    }),
    scan: wrap(async (instanceId?: string) => {
      const { issueHubService } = await import('../../services/issueHub')
      const list = await issueHubService.scan(instanceId ? sanitizeId(instanceId) : undefined)
      broadcast(IPC_EVENTS.issuesChanged, list)
      return list
    }),
    dismiss: wrap(async (id: string) => {
      const { issueHubService } = await import('../../services/issueHub')
      const changed = issueHubService.dismiss(String(id))
      broadcast(IPC_EVENTS.issuesChanged, issueHubService.list(true))
      return changed
    }),
    restore: wrap(async (id: string) => {
      const { issueHubService } = await import('../../services/issueHub')
      const changed = issueHubService.restore(String(id))
      broadcast(IPC_EVENTS.issuesChanged, issueHubService.list(true))
      return changed
    }),
    resolve: wrap(async (id: string) => {
      const { issueHubService } = await import('../../services/issueHub')
      const changed = issueHubService.resolve(String(id))
      broadcast(IPC_EVENTS.issuesChanged, issueHubService.list(true))
      return changed
    }),
    installModule: wrap(async (id: string) => {
      const { issueHubService } = await import('../../services/issueHub')
      const result = await issueHubService.installModule(String(id))
      broadcast(IPC_EVENTS.issuesChanged, issueHubService.list(true))
      return result
    }),
    cleanLeftover: wrap(async (id: string) => {
      const { issueHubService } = await import('../../services/issueHub')
      const result = issueHubService.cleanLeftover(String(id))
      broadcast(IPC_EVENTS.issuesChanged, issueHubService.list(true))
      return result
    })
  }
}
