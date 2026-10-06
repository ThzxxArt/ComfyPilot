import type { ComfyPilotApi } from './index'

declare global {
  interface Window {
    comfyPilot: ComfyPilotApi
  }
}

export {}
