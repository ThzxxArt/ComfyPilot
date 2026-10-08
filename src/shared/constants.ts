import type { AppSettings, LaunchArgTemplate, StarterModel, TorchChannel } from './types'

export const APP_NAME = 'ComfyPilot'
/**
 * Single source of truth for app version.
 * Build injects __APP_VERSION__ from package.json; dev falls back to the literal.
 */
declare const __APP_VERSION__: string | undefined
export const APP_VERSION =
  (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) || '0.1.4'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  locale: 'zh-CN',
  defaultInstancePath: '',
  extraModelPathsFile: '',
  modelScanRoots: [],
  downloadDir: '',
  githubEndpoint: '',
  hfEndpoint: '',
  civitaiEndpoint: 'https://civitai.com',
  enableAutoCheckUpdates: true,
  embedFrontend: true,
  securityLevel: 'normal',
  allowGitUrlInstall: false,
  allowPipInstall: false,
  networkMode: 'public',
  aria2Path: '',
  useAria2: false,
  outputIndexRoot: '',
  launchOnBoot: false,
  minimizeToTray: true,
  autoStartInstancesOnLaunch: true,
  pipIndex: '',
  torchIndexMirror: '',
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
  clip: 'CLIP',
  controlnet: 'ControlNet',
  upscale_models: 'Upscaler',
  embeddings: 'Embedding',
  text_encoders: 'Text Encoder',
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
  cu124: 11,
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
  { url: string; sha256?: string; sizeHint: number; description: string }
> = {
  // uv standalone — also bootstraps CPython via `uv python install`
  'uv-win-x64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.8.15/uv-x86_64-pc-windows-msvc.zip',
    sizeHint: 15 * 1024 * 1024,
    description: 'uv package manager (Windows x64)'
  },
  'uv-linux-x64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.8.15/uv-x86_64-unknown-linux-gnu.tar.gz',
    sizeHint: 15 * 1024 * 1024,
    description: 'uv package manager (Linux x64)'
  },
  'uv-darwin-arm64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.8.15/uv-aarch64-apple-darwin.tar.gz',
    sizeHint: 15 * 1024 * 1024,
    description: 'uv package manager (macOS arm64)'
  },
  'uv-darwin-x64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.8.15/uv-x86_64-apple-darwin.tar.gz',
    sizeHint: 15 * 1024 * 1024,
    description: 'uv package manager (macOS x64)'
  },
  'uv-linux-arm64': {
    url: 'https://github.com/astral-sh/uv/releases/download/0.8.15/uv-aarch64-unknown-linux-gnu.tar.gz',
    sizeHint: 15 * 1024 * 1024,
    description: 'uv package manager (Linux arm64)'
  },
  // MinGit portable — only needed for git-based node installs / clone mode
  'mingit-win-x64': {
    url: 'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip',
    sizeHint: 50 * 1024 * 1024,
    description: 'MinGit portable (Windows x64)'
  },
  // python-build-standalone fallback when uv is unavailable
  'python-win-x64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20250712/cpython-3.12.11+20250712-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
    sizeHint: 25 * 1024 * 1024,
    description: 'Portable CPython 3.12 (Windows x64)'
  },
  'python-linux-x64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20250712/cpython-3.12.11+20250712-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz',
    sizeHint: 25 * 1024 * 1024,
    description: 'Portable CPython 3.12 (Linux x64)'
  },
  'python-darwin-arm64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20250712/cpython-3.12.11+20250712-aarch64-apple-darwin-install_only_stripped.tar.gz',
    sizeHint: 25 * 1024 * 1024,
    description: 'Portable CPython 3.12 (macOS arm64)'
  },
  'python-darwin-x64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20250712/cpython-3.12.11+20250712-x86_64-apple-darwin-install_only_stripped.tar.gz',
    sizeHint: 25 * 1024 * 1024,
    description: 'Portable CPython 3.12 (macOS x64)'
  },
  'python-linux-arm64': {
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20250712/cpython-3.12.11+20250712-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz',
    sizeHint: 25 * 1024 * 1024,
    description: 'Portable CPython 3.12 (Linux arm64)'
  }
}

/** ComfyUI source archive (zip) — default install path, no Git required. */
export const COMFY_ZIP_URL =
  'https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip'

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
