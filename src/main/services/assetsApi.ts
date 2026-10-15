/**
 * ComfyUI assets-system read-only bridge (0.1.14).
 *
 * ComfyUI 0.40 ships a server-side asset database behind `--enable-assets`
 * (on by default in official Windows standalone builds, off for source
 * installs). This module ONLY reads it, by explicit user action, and only
 * when the capability probe (`InstanceCapabilities.assetsApi`) says the API
 * answers. Every failure degrades to null — callers hide the feature instead
 * of surfacing errors.
 *
 * Deliberate boundaries (mirroring the upstream design doc):
 * - no job→outputs reverse query exists upstream; we match by file name
 * - no writes, no sync, no polling — single low-frequency lookups
 * - `job_id` is the prompt id; we optionally resolve it through the local
 *   prompt-links sidecar so the panel can name the workflow too
 */
import type { OutputAssetMatch } from '@shared/types'
import { loadInstanceConfigs } from './db'
import { instanceBaseUrl } from './capabilities'
import { lookupPromptWorkflowLink } from './workflow'

interface RawAsset {
  id?: unknown
  name?: unknown
  loader_path?: unknown
  job_id?: unknown
  tags?: unknown
  preview_url?: unknown
  size?: unknown
  created_at?: unknown
}

function toMatch(raw: RawAsset, baseUrl: string): OutputAssetMatch | null {
  const id = String(raw.id || '')
  if (!id) return null
  const jobId = typeof raw.job_id === 'string' && raw.job_id ? raw.job_id : undefined
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
  let previewUrl: string | undefined
  if (typeof raw.preview_url === 'string' && raw.preview_url) {
    previewUrl = raw.preview_url.startsWith('http')
      ? raw.preview_url
      : `${baseUrl}${raw.preview_url.startsWith('/') ? '' : '/'}${raw.preview_url}`
  }
  // Resolve the prompt id through the local sidecar (read-only convenience).
  const link = jobId ? lookupPromptWorkflowLink(jobId) : undefined
  return {
    id,
    name: String(raw.name || ''),
    loaderPath: typeof raw.loader_path === 'string' ? raw.loader_path : undefined,
    jobId,
    workflowId: link?.workflowId,
    workflowName: link?.workflowName,
    tags,
    previewUrl,
    size: typeof raw.size === 'number' ? raw.size : undefined,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : undefined
  }
}

/**
 * Look up asset records matching an output file name on the instance's asset
 * system. Returns `null` when the instance is unknown, the API is disabled or
 * unreachable; `[]` when the API answered but nothing matched.
 */
export async function matchAssetsByFileName(
  instanceId: string,
  fileName: string,
  timeoutMs = 5000
): Promise<OutputAssetMatch[] | null> {
  const cfg = loadInstanceConfigs().find((c) => c.id === instanceId)
  if (!cfg || !fileName) return null
  try {
    const baseUrl = instanceBaseUrl(cfg)
    const url = `${baseUrl}/api/assets?limit=10&name_contains=${encodeURIComponent(fileName)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const data = (await res.json()) as { assets?: unknown }
    const list = Array.isArray(data.assets) ? (data.assets as RawAsset[]) : []
    // Prefer exact name matches; fall back to the contains-filtered page.
    const exact = list.filter((a) => String(a?.name || '') === fileName)
    const picked = (exact.length ? exact : list).slice(0, 5)
    return picked.map((a) => toMatch(a, baseUrl)).filter((m): m is OutputAssetMatch => m !== null)
  } catch {
    return null
  }
}
