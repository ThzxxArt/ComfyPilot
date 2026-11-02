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
import { basename, join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import type {
  BatchPreflight,
  WorkflowModelPreflight,
  WorkflowModelRequirement,
  WorkflowPreflight
} from '@shared/types'
import { collectPromptModelRefs, missingNodeTypes, modelCategoryForInput } from '@shared/preflight'
import { capabilityService } from './capabilities'
import { resolveReadTarget } from './target'
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
      // 0.2.0: a workflow that cannot be parsed is NOT "available" — callers
      // used to show zero missing nodes and start a run that could never work.
      return {
        available: false,
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

  /**
   * 0.1.18 (WP7): compare the workflow's model references against the LOCAL
   * model index. This is deliberately instance-independent: the index describes
   * what this machine has, which is exactly what a submit-time warning needs.
   * A missing model never blocks the submit — the UI shows it and asks.
   */
  async models(workflowPath: string, instanceId?: string): Promise<WorkflowModelPreflight> {
    try {
      const prompt = await workflowService.buildApiPrompt(workflowPath)
      const refs = collectPromptModelRefs(prompt)
      const { modelService } = await import('./model')
      const local = await modelService.list()
      const byBase = new Map<string, string>()
      const byCategory = new Map<string, Map<string, string>>()
      for (const m of local) {
        const category = String(m.category || '')
        if (category && !byCategory.has(category)) byCategory.set(category, new Map())
        for (const candidate of [m.fileName, m.name, basename(m.path)]) {
          if (!candidate) continue
          byBase.set(candidate.toLowerCase(), m.fileName)
          if (category) byCategory.get(category)!.set(candidate.toLowerCase(), m.fileName)
        }
      }
      // 0.1.18 (regression): the index is machine-global, so a model that only
      // exists in ANOTHER instance was reported "present" and the run failed
      // later. For a named target, also look in that instance's models/ dir.
      const instanceRoot = instanceId ? resolveReadTarget(instanceId)?.path : undefined
      const localMatches = new Map<string, string>()
      const findLocal = (name: string, category?: string): string | undefined => {
        if (!instanceRoot) return undefined
        const modelsDir = join(instanceRoot, 'models', category || '')
        if (!existsSync(modelsDir)) return undefined
        const target = basename(name).toLowerCase()
        const cacheKey = `${category || '*'}:${target}`
        if (localMatches.has(cacheKey)) return localMatches.get(cacheKey) || undefined
        const queue: Array<{ dir: string; depth: number }> = [{ dir: modelsDir, depth: 0 }]
        let visited = 0
        while (queue.length && visited < 5000) {
          const { dir, depth } = queue.shift()!
          let entries: string[]
          try {
            entries = readdirSync(dir)
          } catch {
            continue
          }
          for (const entry of entries) {
            visited++
            const full = join(dir, entry)
            try {
              const st = statSync(full)
              if (st.isDirectory()) {
                if (depth < 2) queue.push({ dir: full, depth: depth + 1 })
                continue
              }
              const lower = entry.toLowerCase()
              if (lower === target) {
                localMatches.set(target, entry)
                return entry
              }
            } catch {
              /* unreadable entry */
            }
          }
        }
        localMatches.set(cacheKey, '')
        return undefined
      }
      const result: WorkflowModelRequirement[] = refs.map((r) => {
        const normalized = r.name.replace(/\\/g, '/').toLowerCase()
        const base = basename(normalized)
        const category = modelCategoryForInput(r.inputKey)
        // 0.2.0: a category-scoped reference must match a model in the SAME
        // category. A global basename map let `SDXL/model` satisfy `SD15/model`
        // and started a run that failed at execution time.
        let matched: string | undefined
        if (category) {
          matched = byCategory.get(category)?.get(base)
          if (!matched) {
            for (const m of local) {
              if (String(m.category || '') !== category) continue
              const rel = m.path.replace(/\\/g, '/').toLowerCase()
              if (rel.endsWith(`/${category}/${normalized}`) || rel.endsWith(`/${normalized}`)) {
                matched = m.fileName
                break
              }
            }
          }
        } else {
          matched = byBase.get(base) || byBase.get(normalized)
        }
        if (!matched) matched = findLocal(r.name, category)
        return {
          name: r.name,
          nodeType: r.nodeType,
          inputKey: r.inputKey,
          category,
          present: Boolean(matched),
          matchedFile: matched
        }
      })
      const missing = result.filter((r) => !r.present)
      return {
        available: true,
        required: result.length,
        present: result.length - missing.length,
        missing
      }
    } catch (e) {
      return {
        available: false,
        required: 0,
        present: 0,
        missing: [],
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }
}

export const preflightService = new PreflightService()
