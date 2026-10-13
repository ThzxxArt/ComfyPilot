/**
 * Model category → icon + accent hue (0.1.11).
 *
 * The models table used to render an EMPTY tinted square when a model had no
 * thumbnail — users read it as a broken image. Every category now maps to a
 * meaningful icon with a stable accent color.
 */
import type { Component } from 'vue'
import {
  BrushOutline,
  ColorPaletteOutline,
  ColorWandOutline,
  ConstructOutline,
  CubeOutline,
  CutOutline,
  ExpandOutline,
  EyeOutline,
  FileTrayOutline,
  FilmOutline,
  FlashOutline,
  GitNetworkOutline,
  GridOutline,
  LayersOutline,
  ListOutline,
  MusicalNotesOutline,
  OptionsOutline,
  PersonOutline,
  PricetagOutline,
  ResizeOutline,
  ScanOutline,
  SparklesOutline,
  SwapHorizontalOutline,
  TextOutline
} from '@vicons/ionicons5'
import type { ModelCategory } from '@shared/types'

export interface CategoryVisual {
  icon: Component
  /** Accent hue for the placeholder background (hex, alpha applied in CSS). */
  tone: string
}

const MAP: Record<ModelCategory, CategoryVisual> = {
  checkpoints: { icon: LayersOutline, tone: '#4f6ef7' },
  diffusion_models: { icon: CubeOutline, tone: '#7c5cf0' },
  loras: { icon: ColorWandOutline, tone: '#e0699f' },
  vae: { icon: ColorPaletteOutline, tone: '#2fb8a6' },
  text_encoders: { icon: TextOutline, tone: '#5a8dee' },
  clip_vision: { icon: EyeOutline, tone: '#8f6df0' },
  controlnet: { icon: OptionsOutline, tone: '#e08b3c' },
  upscale_models: { icon: ResizeOutline, tone: '#3aa675' },
  embeddings: { icon: PricetagOutline, tone: '#c0506e' },
  style_models: { icon: BrushOutline, tone: '#9a6de0' },
  diffusers: { icon: SparklesOutline, tone: '#4f8ff0' },
  vae_approx: { icon: FlashOutline, tone: '#d7a13b' },
  gligen: { icon: GridOutline, tone: '#5f9bd8' },
  latent_upscale_models: { icon: ExpandOutline, tone: '#3f9e8f' },
  photomaker: { icon: PersonOutline, tone: '#d0679a' },
  classifiers: { icon: ListOutline, tone: '#6b86c9' },
  model_patches: { icon: ConstructOutline, tone: '#b0873f' },
  audio_encoders: { icon: MusicalNotesOutline, tone: '#6a7fd6' },
  hypernetworks: { icon: GitNetworkOutline, tone: '#a06ad0' },
  background_removal: { icon: CutOutline, tone: '#4d9e6f' },
  frame_interpolation: { icon: FilmOutline, tone: '#4f8aae' },
  geometry_estimation: { icon: CubeOutline, tone: '#7f7fd0' },
  optical_flow: { icon: SwapHorizontalOutline, tone: '#4aa3b8' },
  detection: { icon: ScanOutline, tone: '#c96a4a' },
  // Legacy aliases
  clip: { icon: TextOutline, tone: '#5a8dee' },
  unet: { icon: CubeOutline, tone: '#7c5cf0' },
  other: { icon: FileTrayOutline, tone: '#8a93a6' }
}

export function categoryVisual(cat: string): CategoryVisual {
  return MAP[cat as ModelCategory] || MAP.other
}
