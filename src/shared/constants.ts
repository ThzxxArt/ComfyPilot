import type { AppSettings, LaunchArgTemplate, StarterModel, TorchChannel } from './types'

export const APP_NAME = 'ComfyPilot'
/**
 * Single source of truth for app version.
 * Build injects __APP_VERSION__ from package.json; dev falls back to the literal.
 */
declare const __APP_VERSION__: string | undefined
export const APP_VERSION = (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || '0.2.1'

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'zh-CN',
  modelScanRoots: [],
  githubEndpoint: '',
  hfEndpoint: '',
  civitaiEndpoint: 'https://civitai.com',
  enableAutoCheckUpdates: true,
  embedFrontend: true,
  securityLevel: 'normal',
  allowGitUrlInstall: false,
  // Node packs ship their own requirements.txt — installing them is the
  // expected behaviour for a zero-threshold tool. Turn off in Settings if you
  // prefer to manage deps manually (ComfyUI-Manager "weak/strong" semantics).
  allowPipInstall: true,
  networkMode: 'public',
  aria2Path: '',
  useAria2: false,
  launchOnBoot: false,
  minimizeToTray: true,
  autoStartInstancesOnLaunch: true,
  pipIndex: '',
  torchIndexMirror: '',
  outputScanDepth: 4,
  stopMode: 'fast',
  proxy: {
    enabled: false,
    protocol: 'http',
    host: '',
    port: 7890,
    username: '',
    password: '',
    bypass: 'localhost,127.0.0.1,::1'
  }
}

export const MODEL_CATEGORY_LABELS: Record<string, string> = {
  checkpoints: 'Checkpoint',
  diffusion_models: 'Diffusion Model',
  loras: 'LoRA',
  vae: 'VAE',
  text_encoders: 'Text Encoder',
  clip_vision: 'CLIP Vision',
  controlnet: 'ControlNet',
  upscale_models: 'Upscaler',
  embeddings: 'Embedding',
  style_models: 'Style Model',
  diffusers: 'Diffusers',
  vae_approx: 'VAE Approx',
  gligen: 'GLIGEN',
  latent_upscale_models: 'Latent Upscaler',
  photomaker: 'PhotoMaker',
  classifiers: 'Classifier',
  model_patches: 'Model Patch',
  audio_encoders: 'Audio Encoder',
  hypernetworks: 'Hypernetwork',
  background_removal: 'BG Removal',
  frame_interpolation: 'Frame Interpolation',
  geometry_estimation: 'Geometry Estimation',
  optical_flow: 'Optical Flow',
  detection: 'Detection',
  // Legacy aliases
  clip: 'CLIP',
  unet: 'UNet',
  other: 'Other'
}

export const COMFY_DEFAULT_PORTS = [8188, 8189, 8190, 8191, 8192, 8288, 8388]

// name/description are i18n KEY FRAGMENTS (launchTpl.<id>.name / .desc).
// Renderer resolves them via t(); never put UI copy in this table.
export const LAUNCH_TEMPLATES: LaunchArgTemplate[] = [
  {
    id: 'default',
    name: 'default',
    args: [],
    description: 'default'
  },
  {
    id: 'preview-taesd',
    name: 'preview-taesd',
    args: ['--preview-method', 'taesd', '--preview-size', '512'],
    description: 'preview-taesd'
  },
  {
    id: 'manager',
    name: 'manager',
    args: ['--enable-manager'],
    description: 'manager'
  },
  {
    id: 'offline',
    name: 'offline',
    args: ['--offline'],
    description: 'offline'
  },
  {
    id: 'lan',
    name: 'lan',
    args: ['--listen', '0.0.0.0'],
    description: 'lan'
  },
  {
    id: 'lowvram',
    name: 'lowvram',
    args: ['--lowvram'],
    description: 'lowvram'
  },
  {
    id: 'vram-save',
    name: 'vram-save',
    // Modern (0.39-era) memory saving: dynamic VRAM is the default, so the
    // useful knobs are a reserved floor + fast-disk offloading. Requires a
    // recent ComfyUI build — older ones reject unknown flags at startup.
    args: ['--reserve-vram', '1', '--fast-disk'],
    description: 'vram-save'
  },
  {
    id: 'cache-none',
    name: 'cache-none',
    args: ['--cache-none'],
    description: 'cache-none'
  },
  {
    id: 'cpu',
    name: 'cpu',
    args: ['--cpu'],
    description: 'cpu'
  }
]

export const REGISTRY_API = 'https://api.comfy.org'
export const NODE_SNAPSHOT_PREFIX = 'cp-snapshot'

// ---------- Network mirror presets (Settings / Install wizard) ----------
// Labels are value-stable; UI maps value → i18n key (settings.pipOfficial / torchSjtu / …).
export const PIP_INDEX_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'pip-official', value: '' },
  { label: 'pip-tuna', value: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { label: 'pip-aliyun', value: 'https://mirrors.aliyun.com/pypi/simple/' },
  { label: 'pip-ustc', value: 'https://pypi.mirrors.ustc.edu.cn/simple/' }
]

export const TORCH_INDEX_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'torch-official', value: '' },
  // Wheel mirrors publish `<prefix>/<channel>/` (NOT `/whl/<channel>`).
  // resolveTorchIndex appends the channel directory to these prefixes.
  { label: 'torch-sjtu', value: 'https://mirror.sjtu.edu.cn/pytorch-wheels' },
  { label: 'torch-aliyun', value: 'https://mirrors.aliyun.com/pytorch-wheels' }
]

/** Rough on-disk cost of a torch channel install (wheel + unpack), used for preflight. */
export const TORCH_DISK_GB: Record<TorchChannel, number> = {
  cu130: 12,
  cu126: 12,
  rocm: 14,
  xpu: 8,
  mps: 4,
  cpu: 3
}

// ---------- Runtime bootstrap artifacts (downloaded on demand) ----------
/**
 * Pinned runtime downloads. Versions are fixed so installs are reproducible;
 * bump deliberately. URLs go through githubEndpoint mirror when configured.
 */
export const RUNTIME_SOURCES: Record<
  string,
  /*
   * 0.1.18 (regression fix): `sha256` is a build-time pin for assets whose
   * upstream ships no `.sha256` sidecar (MinGit) or whose sidecar is not
   * reachable through a mirror (China). It is the strongest check: a mismatch
   * always copies nothing and deletes the download. The Windows pins were
   * hashed from the exact release assets (uv/python cross-checked against the
   * official manifests).
   */
  { url: string; sizeHint: number; description: string; sha256?: string }
> = {
  // uv standalone — also bootstraps CPython via `uv python install`
  'uv-win-x64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-pc-windows-msvc.zip',
    sizeHint: 18 * 1024 * 1024,
    description: 'uv package manager (Windows x64)',
    sha256: 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'
  },
  'uv-linux-x64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-unknown-linux-gnu.tar.gz',
    sizeHint: 18 * 1024 * 1024,
    description: 'uv package manager (Linux x64)',
    sha256: 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645'
  },
  'uv-darwin-arm64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-aarch64-apple-darwin.tar.gz',
    sizeHint: 18 * 1024 * 1024,
    description: 'uv package manager (macOS arm64)',
    sha256: '60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472'
  },
  'uv-darwin-x64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-x86_64-apple-darwin.tar.gz',
    sizeHint: 18 * 1024 * 1024,
    description: 'uv package manager (macOS x64)',
    sha256: '63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02'
  },
  'uv-linux-arm64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.13.6/uv-aarch64-unknown-linux-gnu.tar.gz',
    sizeHint: 18 * 1024 * 1024,
    description: 'uv package manager (Linux arm64)',
    sha256: '229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d'
  },
  // MinGit portable — only needed for git-based node installs / clone mode
  'mingit-win-x64': {
    url: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip',
    sizeHint: 55 * 1024 * 1024,
    description: 'MinGit portable (Windows x64)',
    sha256: 'e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877'
  },
  // python-build-standalone fallback when uv is unavailable (0.2.0: 3.13 only)
  'python-win-x64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18+20261026-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
    sizeHint: 22 * 1024 * 1024,
    description: 'Portable CPython 3.13.18 (Windows x64)',
    sha256: '7369f7a35f261222a6ac8b3a87c1c88eeebee8af945d85346202591a64038dd3'
  },
  'python-linux-x64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
    sizeHint: 36 * 1024 * 1024,
    description: 'Portable CPython 3.13.18 (Linux x64)',
    sha256: 'df15fe60d3ff55bf9dcf25824b5572756bb8816ff93865a273d3301d7066a8b7'
  },
  'python-darwin-arm64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18+20261026-aarch64-apple-darwin-install_only_stripped.tar.gz',
    sizeHint: 26 * 1024 * 1024,
    description: 'Portable CPython 3.13.18 (macOS arm64)',
    sha256: '8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405'
  },
  'python-darwin-x64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18+20261026-x86_64-apple-darwin-install_only_stripped.tar.gz',
    sizeHint: 26 * 1024 * 1024,
    description: 'Portable CPython 3.13.18 (macOS x64)',
    sha256: '7412c19d896c99431b74a18a5643e110449a7f9590fbab179c3e5ab27b9aa9e3'
  },
  'python-linux-arm64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18+20261026-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz',
    sizeHint: 30 * 1024 * 1024,
    description: 'Portable CPython 3.13.18 (Linux arm64)',
    sha256: '578d9da1983463ffb0c8c98ab0da2f18177f44069328eb0af847860c1eb05c3e'
  }
}

/** 0.2.0: the only supported Python runtime. */
export const PYTHON_RUNTIME_VERSION = '3.13.18'
export const PYTHON_RUNTIME_MINOR = '3.13'

/** ComfyUI source archive (zip) — default install path, no Git required. */
// Official repository: Comfy-Org/ComfyUI (0.1.14 switched off the old
// comfyanonymous/ URL, which only worked via GitHub redirects).
export const COMFY_ZIP_URL = 'https://github.com/Comfy-Org/ComfyUI/archive/refs/heads/master.zip'

/**
 * Starter models for the post-install guided download.
 * URLs are HF resolve links — model.download rewrites via hfEndpoint when set.
 * `description` is an i18n KEY (starterModels.<id>.desc) — UI translates it.
 */
export const STARTER_MODELS: StarterModel[] = [
  {
    id: 'sd15-v1-5-pruned-emaonly',
    name: 'Stable Diffusion 1.5',
    description: 'starterModels.sd15.desc',
    url: 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors',
    category: 'checkpoints',
    approxBytes: 2 * 1024 ** 3,
    family: 'SD 1.5',
    recommended: true
  },
  {
    id: 'sdxl-base-1-0',
    name: 'SDXL Base 1.0',
    description: 'starterModels.sdxl.desc',
    url: 'https://huggingface.co/Comfy-Org/stable-diffusion-xl-base-1.0-archive/resolve/main/sd_xl_base_1.0.safetensors',
    category: 'checkpoints',
    approxBytes: 6.9 * 1024 ** 3,
    family: 'SDXL'
  },
  {
    id: 'flux1-schnell',
    name: 'Flux.1-schnell',
    description: 'starterModels.flux.desc',
    url: 'https://huggingface.co/Comfy-Org/flux1-schnell/resolve/main/flux1-schnell-fp8.safetensors',
    category: 'unet',
    approxBytes: 12 * 1024 ** 3,
    family: 'Flux'
  }
]
