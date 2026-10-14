/**
 * Workflow preflight service (0.1.12 WP6).
 *
 * Compares a workflow's node class types against the running instance's
 * /object_info registration. Honest boundaries:
 * - Only node-type presence is checkable. Dependency-level failures
 *   (lazy imports like sageattention inside a registered node) surface at
 *   execution time — handled by the failure-diagnosis pipeline instead.
 * - object_info unreachable → `available:false`; callers must SKIP the
 *   dialog, never claim "all nodes present".
 */
import { basename } from 'path'
import type { BatchPreflight, WorkflowPreflight } from '@shared/types'
import { missingNodeTypes } from '@shared/preflight'
import { capabilityService } from './capabilities'
import { workflowService } from './workflow'

export class PreflightService {
  async workflow(workflowPath: string, instanceId: string): Promise<WorkflowPreflight> {
    const map = await capabilityService.nodeTypeMap(instanceId)
    if (!map) {
      return {
        available: false,
        missingTypes: [],
        nodeTypes: 0,
        error: 'object_info unavailable (instance offline or old server)'
      }
    }
    try {
      const prompt = await workflowService.buildApiPrompt(workflowPath)
      return {
        available: true,
        missingTypes: missingNodeTypes(prompt, map.types),
        nodeTypes: map.types.size
      }
    } catch (e) {
      return {
        available: true,
        missingTypes: [],
        nodeTypes: map.types.size,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  async batch(workflowPaths: string[], instanceId: string): Promise<BatchPreflight> {
    const map = await capabilityService.nodeTypeMap(instanceId)
    if (!map) {
      return {
        available: false,
        missingTypes: [],
        perWorkflow: workflowPaths.map((p) => ({
          workflowPath: p,
          name: basename(p),
          missingTypes: [],
          error: 'object_info unavailable'
        })),
        error: 'object_info unavailable (instance offline or old server)'
      }
    }
    const all = new Set<string>()
    const perWorkflow: BatchPreflight['perWorkflow'] = []
    for (const p of workflowPaths) {
      try {
        const prompt = await workflowService.buildApiPrompt(p)
        const missing = missingNodeTypes(prompt, map.types)
        for (const m of missing) all.add(m)
        perWorkflow.push({ workflowPath: p, name: basename(p), missingTypes: missing })
      } catch (e) {
        perWorkflow.push({
          workflowPath: p,
          name: basename(p),
          missingTypes: [],
          error: e instanceof Error ? e.message : String(e)
        })
      }
    }
    return { available: true, missingTypes: [...all].sort(), perWorkflow }
  }
}

export const preflightService = new PreflightService()
