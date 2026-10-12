import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { readFileSync } from 'fs'

const readSrc = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8')

// ============ Every service file has proper structure ============
describe('service file structure', () => {
  const services = [
    'backup.ts',
    'bootstrap.ts',
    'comfyApi.ts',
    'db.ts',
    'desktop.ts',
    'doctor.ts',
    'env.ts',
    'installer.ts',
    'instance.ts',
    'media.ts',
    'model.ts',
    'monitor.ts',
    'netProbe.ts',
    'nodePack.ts',
    'p1p2.ts',
    'proxy.ts',
    'registry.ts',
    'registryIndex.ts',
    'security.ts',
    'tray.ts',
    'updater.ts',
    'workflow.ts',
    'workflowConvert.ts',
    'zipSafe.ts',
    'zipWrite.ts'
  ]
  for (const f of services) {
    it(`${f} has exports`, () => {
      const src = readSrc(`src/main/services/${f}`)
      expect(src).toContain('export')
    })
  }

  // Files that import from other modules
  const importing = [
    'backup.ts',
    'bootstrap.ts',
    'db.ts',
    'doctor.ts',
    'env.ts',
    'installer.ts',
    'instance.ts',
    'media.ts',
    'model.ts',
    'monitor.ts',
    'netProbe.ts',
    'nodePack.ts',
    'p1p2.ts',
    'proxy.ts',
    'registry.ts',
    'registryIndex.ts',
    'security.ts',
    'updater.ts',
    'workflow.ts',
    'zipSafe.ts'
  ]
  for (const f of importing) {
    it(`${f} has imports`, () => {
      const src = readSrc(`src/main/services/${f}`)
      expect(src).toContain('import')
    })
  }
})

// ============ Every view has proper error handling ============
describe('view error handling completeness', () => {
  const views = [
    'dashboard/DashboardView.vue',
    'instances/InstancesView.vue',
    'instances/InstanceDetailView.vue',
    'models/ModelsView.vue',
    'nodes/NodesView.vue',
    'nodes/MarketView.vue',
    'workflows/WorkflowsView.vue',
    'workflows/BatchView.vue',
    'output/OutputView.vue',
    'monitor/MonitorView.vue',
    'doctor/DoctorView.vue',
    'install/InstallView.vue',
    'backup/BackupView.vue',
    'settings/SettingsView.vue',
    'embed/EmbedView.vue'
  ]
  for (const v of views) {
    it(`${v.split('/').pop()} has catch blocks`, () => {
      const src = readSrc(`src/renderer/src/views/${v}`)
      expect(src).toContain('catch')
    })
  }
})
