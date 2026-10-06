import type { AppSettings, LaunchArgTemplate } from './types'

export const APP_NAME = 'ComfyPilot'
/** Single source of truth for app version — keep in sync with package.json */
export const APP_VERSION = '0.1.0'

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
  remoteInstances: [],
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

export const LAUNCH_TEMPLATES: LaunchArgTemplate[] = [
  {
    id: 'default',
    name: '默认本地',
    args: [],
    description: '仅监听 127.0.0.1，适合日常使用'
  },
  {
    id: 'preview-taesd',
    name: '高质量预览',
    args: ['--preview-method', 'taesd', '--preview-size', '512'],
    description: '启用 TAESD 高清预览（需 models/vae_approx）'
  },
  {
    id: 'manager',
    name: '启用 Manager',
    args: ['--enable-manager'],
    description: '启用 ComfyUI-Manager 后台能力'
  },
  {
    id: 'offline',
    name: '完全离线',
    args: ['--offline'],
    description: '禁用付费 API 节点，强制离线'
  },
  {
    id: 'lan',
    name: '局域网共享',
    args: ['--listen', '0.0.0.0'],
    description: '监听所有网卡（注意安全）'
  },
  {
    id: 'lowvram',
    name: '低显存',
    args: ['--lowvram'],
    description: '低显存优化加载'
  },
  {
    id: 'cpu',
    name: 'CPU 模式',
    args: ['--cpu'],
    description: '强制使用 CPU 推理'
  }
]

export const REGISTRY_API = 'https://api.comfy.org'
export const NODE_SNAPSHOT_PREFIX = 'cp-snapshot'
