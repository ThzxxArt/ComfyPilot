/** Shared model library + output library types. */
import type { OutputType } from '../mediaTypes'

// ---------- Model ----------
/**
 * Canonical category set = ComfyUI's registered model folders (folder_paths.py)
 * minus non-model internals. `clip` / `unet` are legacy aliases kept readable
 * for old DB records only — scan() now maps them to text_encoders / diffusion_models.
 */
export type ModelCategory =
  | 'checkpoints'
  | 'diffusion_models'
  | 'loras'
  | 'vae'
  | 'text_encoders'
  | 'clip_vision'
  | 'controlnet'
  | 'upscale_models'
  | 'embeddings'
  | 'style_models'
  | 'diffusers'
  | 'vae_approx'
  | 'gligen'
  | 'latent_upscale_models'
  | 'photomaker'
  | 'classifiers'
  | 'model_patches'
  | 'audio_encoders'
  | 'hypernetworks'
  | 'background_removal'
  | 'frame_interpolation'
  | 'geometry_estimation'
  | 'optical_flow'
  | 'detection'
  // Legacy aliases (pre-0.1.8 records only)
  | 'clip'
  | 'unet'
  | 'other'

export interface ModelRecord {
  id: string
  name: string
  fileName: string
  category: ModelCategory
  path: string
  size: number
  hashSha256?: string
  modifiedAt: number
  architecture?: string
  source: 'local' | 'civitai' | 'huggingface' | 'imported'
  thumbnail?: string
  tags: string[]
  metadata: Record<string, unknown>
  baseModel?: string
  trainedWords: string[]
  duplicateOf?: string
  pathRoot: string
}

export interface ModelScanProgress {
  scanned: number
  total: number
  currentPath: string
  phase: 'walk' | 'hash' | 'meta' | 'done'
}

export interface DownloadTask {
  id: string
  url: string
  destPath: string
  fileName: string
  totalBytes: number
  receivedBytes: number
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  error?: string
  startedAt: number
  finishedAt?: number
  speedBps?: number
  resumedFrom?: number
  source: 'huggingface' | 'civitai' | 'direct'
  /** Expected SHA256 from remote manifest (if provided) — verified on completion. */
  expectedSha256?: string
  /** Computed SHA256 after a successful download (when verification ran). */
  actualSha256?: string
  /** 'length' = Content-Length match only; 'sha256' = hash verified. */
  verified?: 'length' | 'sha256' | 'failed'
  /** HTTP validators captured on the first response (0.1.18 resume safety). */
  etag?: string
  lastModified?: string
  /**
   * 0.1.18 (WP7): queue priority (higher runs first among waiting tasks).
   * Default 0; bumping it moves a queued task ahead of later arrivals.
   */
  priority?: number
}

export interface StorageStats {
  category: ModelCategory | 'total'
  count: number
  bytes: number
}

export interface DuplicateGroup {
  hash: string
  size: number
  files: string[]
}

export interface OutputAsset {
  id: string
  path: string
  fileName: string
  /** Classified via `@shared/mediaTypes::classifyOutputType` (0.1.14: adds '3d'). */
  type: OutputType
  size: number
  createdAt: number
  width?: number
  height?: number
  workflowId?: string
  workflowName?: string
  batchJobId?: string
  promptId?: string
  seed?: number
  favorite?: boolean
  params: Record<string, unknown>
  thumbnail?: string
  /** Full-resolution safe media URL for lightbox/detail (never a bare fs path). */
  mediaUrl?: string
  /**
   * True when the image has no cached thumbnail yet (0.1.18 WP4). The list IPC
   * no longer generates thumbnails inline; the renderer asks for them lazily
   * via `output.thumb`.
   */
  thumbPending?: boolean
}

/**
 * Read-only mirror of one ComfyUI assets-system record matching an output
 * (0.1.14). Produced on demand by `output.assetsMatch`; never persisted.
 */
export interface OutputAssetMatch {
  id: string
  name: string
  loaderPath?: string
  /** Prompt id this record was created for (assets `job_id`). */
  jobId?: string
  /** Workflow attribution resolved through the local prompt-links sidecar. */
  workflowId?: string
  workflowName?: string
  tags: string[]
  /** Absolute URL of the server-side preview (EXR etc.), when offered. */
  previewUrl?: string
  size?: number
  createdAt?: string
}
