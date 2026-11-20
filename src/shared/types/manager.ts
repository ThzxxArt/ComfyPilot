/** ComfyUI-Manager v4.4 facts (0.2.5 WP4). */
export type ManagerSecurityLevel = 'strong' | 'normal' | 'normal-' | 'weak'
export type ManagerNetworkMode = 'public' | 'private' | 'offline' | 'personal_cloud'

export interface ManagerInfo {
  installed: boolean
  version?: string
  source: 'pip' | 'git' | 'none'
  configPath?: string
  configExists: boolean
  securityLevel?: ManagerSecurityLevel
  networkMode?: ManagerNetworkMode
  snapshotsDir?: string
  legacyBackup?: string
  legacyConfigPath?: string
  warnings: string[]
}
