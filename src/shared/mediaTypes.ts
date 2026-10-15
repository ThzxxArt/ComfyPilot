/**
 * Output media type catalogue (0.1.14) — single source of truth for
 * classifying output files and for deciding what inline preview is possible.
 *
 * Before this module, classification lived in four drifting copies:
 * three inline regex chains in `p1p2.ts` (indexPromptOutput / walk / indexFile
 * — mkv was missing in two of them and the third defaulted unknowns to
 * 'image') and the `MEDIA_EXT` set in `media.ts` (no audio, no 3D, no raw
 * images). Every consumer — scanner, indexer, media protocol, renderer — now
 * derives from this catalogue.
 *
 * Note: this module is imported by the renderer too, so it must stay free of
 * Node built-ins (extension extraction is hand-rolled on purpose).
 */

export type OutputType = 'image' | 'video' | 'audio' | '3d' | 'other'

/** Images Chromium can decode and display inline. */
export const IMAGE_WEB_EXT: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.bmp'
]

/**
 * Image formats browsers cannot decode: indexed as images (params/exports
 * still apply) but never inline-rendered — the UI degrades to an icon and
 * "open with system player" (0.1.14; ComfyUI 0.40 adds EXR/HDR output paths).
 */
export const IMAGE_RAW_EXT: readonly string[] = ['.exr', '.hdr', '.tif', '.tiff']

export const VIDEO_EXT: readonly string[] = ['.mp4', '.webm', '.mkv', '.mov']

export const AUDIO_EXT: readonly string[] = [
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.m4a',
  '.aac',
  '.opus'
]

/** 3D mesh/scene outputs (ComfyUI 0.40 standardizes .glb outputs). */
export const MODEL3D_EXT: readonly string[] = ['.glb', '.gltf', '.obj', '.fbx', '.ply', '.stl']

const IMAGE_WEB_SET = new Set(IMAGE_WEB_EXT)
const IMAGE_RAW_SET = new Set(IMAGE_RAW_EXT)
const VIDEO_SET = new Set(VIDEO_EXT)
const AUDIO_SET = new Set(AUDIO_EXT)
const MODEL3D_SET = new Set(MODEL3D_EXT)

/** Lower-case extension including the dot (`''` when there is none). */
export function extOf(fileName: string): string {
  const base = String(fileName || '')
  const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'))
  const name = slash >= 0 ? base.slice(slash + 1) : base
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  const ext = name.slice(i).toLowerCase()
  // Guard against "file.name with spaces" style false positives.
  return /^\.[a-z0-9]+$/.test(ext) ? ext : ''
}

/** Classify an output file into the app's type taxonomy. */
export function classifyOutputType(fileName: string): OutputType {
  const ext = extOf(fileName)
  if (!ext) return 'other'
  if (IMAGE_WEB_SET.has(ext) || IMAGE_RAW_SET.has(ext)) return 'image'
  if (VIDEO_SET.has(ext)) return 'video'
  if (AUDIO_SET.has(ext)) return 'audio'
  if (MODEL3D_SET.has(ext)) return '3d'
  return 'other'
}

/** True when the file is an image the renderer can display inline. */
export function isWebViewableImage(fileName: string): boolean {
  return IMAGE_WEB_SET.has(extOf(fileName))
}

/** True when the file is a raw image format (EXR/HDR/TIFF family). */
export function isRawImage(fileName: string): boolean {
  return IMAGE_RAW_SET.has(extOf(fileName))
}

/**
 * Files the `comfy-pilot-media:` protocol may serve: web images (for thumbs +
 * lightbox), videos (Chromium decodes mp4/webm; mkv/mov degrade in the UI) and
 * audio (Chromium decodes wav/mp3/flac/ogg/m4a; others degrade the same way).
 * Raw images and 3D files stay out — they are opened with the OS default app.
 */
export function isMediaServable(fileName: string): boolean {
  const ext = extOf(fileName)
  return IMAGE_WEB_SET.has(ext) || VIDEO_SET.has(ext) || AUDIO_SET.has(ext)
}
