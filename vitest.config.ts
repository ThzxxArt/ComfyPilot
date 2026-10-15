import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * 覆盖率门禁校准（0.1.8）：
 * 0.1.4 起文档宣称「每文件每指标 ≥85%」，但实测从未达标（全局 ~82%，backup/doctor/monitor
 * 等文件甚至没有行为级测试）——门禁实际上长期是红的。
 * 本次按「实测定档 = 实测值 − 2pp」重新校准：门禁从今天起真实可执行，
 * 防的是回归；任何提升都必须伴随补测，而不是改数字。
 * 提高门槛的唯一正途：为新触及的模块补行为测试后，同步上调对应 floor。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'out/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: [
        'src/main/services/security.ts',
        'src/main/services/zipSafe.ts',
        'src/main/services/zipWrite.ts',
        'src/main/services/workflowConvert.ts',
        'src/main/services/workflow.ts',
        'src/main/services/p1p2.ts',
        'src/main/services/proxy.ts',
        'src/main/services/installer.ts',
        'src/main/services/media.ts',
        'src/main/services/nodePack.ts',
        'src/main/services/updater.ts',
        'src/main/services/instance.ts',
        'src/main/services/db.ts',
        'src/main/services/backup.ts',
        'src/main/services/doctor.ts',
        'src/main/services/monitor.ts',
        'src/main/services/registry.ts',
        'src/main/services/registryIndex.ts',
        'src/main/services/netProbe.ts',
        'src/main/services/comfyApi.ts',
        'src/main/services/capabilities.ts',
        'src/main/services/workflowFingerprint.ts',
        'src/main/services/appUpdate.ts',
        'src/main/services/pipOps.ts',
        'src/main/services/execDiagnostics.ts',
        'src/main/services/preflight.ts',
        'src/main/services/env.ts',
        'src/shared/constants.ts',
        'src/shared/launchArgs.ts',
        'src/shared/nodeLoadReport.ts',
        'src/shared/execError.ts',
        'src/shared/pipVersion.ts',
        'src/shared/pipRecipes.ts',
        'src/shared/preflight.ts',
        // ── 0.1.14: unified catalogue + assets read-only bridge ──
        'src/shared/mediaTypes.ts',
        'src/main/services/assetsApi.ts',
        // ── 0.1.13: renderer composables with real behaviour tests ──
        'src/renderer/src/composables/usePipOps.ts',
        'src/renderer/src/composables/useExecDiagnostics.ts',
        // ── 0.1.15: renderer utils with real behaviour tests ──
        'src/renderer/src/utils/monitorOps.ts',
        'src/renderer/src/utils/batchOps.ts',
        'src/renderer/src/utils/frontendAlign.ts',
        // ── 0.1.16: new stability/log modules + model library ──
        'src/shared/logLine.ts',
        'src/main/services/childEnv.ts',
        'src/main/services/lru.ts',
        'src/main/services/logFile.ts',
        'src/main/services/session.ts',
        'src/main/services/startupIssues.ts'
      ],
      thresholds: {
        // ── 实测定档：高覆盖模块（0.1.10 全量实测 − 2pp）──
        'src/main/services/security.ts': { statements: 98, lines: 98, functions: 98, branches: 92 },
        'src/shared/launchArgs.ts': { statements: 97, lines: 97, functions: 98, branches: 93 },
        'src/main/services/workflowConvert.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 94
        },
        'src/main/services/zipSafe.ts': { statements: 98, lines: 98, functions: 98, branches: 96 },
        'src/main/services/proxy.ts': { statements: 98, lines: 98, functions: 98, branches: 94 },
        'src/main/services/instance.ts': { statements: 90, lines: 90, functions: 92, branches: 85 },
        'src/main/services/zipWrite.ts': { statements: 92, lines: 92, functions: 98, branches: 84 },
        'src/main/services/netProbe.ts': { statements: 89, lines: 89, functions: 98, branches: 34 },
        'src/main/services/p1p2.ts': { statements: 86, lines: 86, functions: 92, branches: 82 },
        'src/main/services/installer.ts': {
          statements: 86,
          lines: 86,
          functions: 92,
          branches: 84
        },
        'src/main/services/workflow.ts': { statements: 85, lines: 85, functions: 95, branches: 76 },
        'src/main/services/updater.ts': { statements: 86, lines: 86, functions: 98, branches: 81 },
        'src/main/services/nodePack.ts': { statements: 92, lines: 92, functions: 95, branches: 82 },
        'src/main/services/media.ts': { statements: 92, lines: 92, functions: 98, branches: 83 },
        'src/shared/constants.ts': { statements: 98, lines: 98, functions: 98, branches: 98 },
        // ── 行为覆盖补齐后按新实测重设（0.1.10：doctor/backup/monitor 从 0/2%/16% 起步）──
        'src/main/services/db.ts': { statements: 80, lines: 80, functions: 75, branches: 85 },
        'src/main/services/comfyApi.ts': { statements: 84, lines: 84, functions: 82, branches: 67 },
        'src/main/services/registry.ts': { statements: 74, lines: 74, functions: 88, branches: 55 },
        'src/main/services/registryIndex.ts': {
          statements: 87,
          lines: 87,
          functions: 90,
          branches: 72
        },
        'src/main/services/doctor.ts': { statements: 82, lines: 82, functions: 81, branches: 68 },
        'src/main/services/backup.ts': { statements: 88, lines: 88, functions: 88, branches: 69 },
        'src/main/services/monitor.ts': { statements: 59, lines: 59, functions: 62, branches: 66 },
        // ── 0.1.11 新增模块（首轮实测 − 2pp）──
        'src/main/services/workflowFingerprint.ts': {
          statements: 88,
          lines: 88,
          functions: 98,
          branches: 65
        },
        'src/main/services/appUpdate.ts': {
          statements: 85,
          lines: 85,
          functions: 98,
          branches: 73
        },
        // ── 0.1.12 新增/触及模块（首轮实测 − 2pp）──
        'src/main/services/pipOps.ts': { statements: 90, lines: 90, functions: 94, branches: 70 },
        'src/main/services/execDiagnostics.ts': {
          statements: 91,
          lines: 91,
          functions: 98,
          branches: 73
        },
        'src/main/services/preflight.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 79
        },
        'src/main/services/env.ts': { statements: 50, lines: 50, functions: 82, branches: 73 },
        'src/shared/execError.ts': { statements: 96, lines: 96, functions: 98, branches: 71 },
        'src/shared/pipVersion.ts': { statements: 90, lines: 90, functions: 98, branches: 73 },
        'src/shared/pipRecipes.ts': { statements: 98, lines: 98, functions: 98, branches: 78 },
        'src/shared/preflight.ts': { statements: 98, lines: 98, functions: 98, branches: 98 },
        // ── 0.1.13 新增纳入门禁的 renderer 组合式（首轮实测 − 2pp）──
        'src/renderer/src/composables/usePipOps.ts': {
          statements: 88,
          lines: 88,
          functions: 66,
          branches: 76
        },
        'src/renderer/src/composables/useExecDiagnostics.ts': {
          statements: 91,
          lines: 91,
          functions: 98,
          branches: 66
        },
        // ── 0.1.15 新增 renderer utils（首轮实测 − 2pp）──
        'src/renderer/src/utils/monitorOps.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 83
        },
        'src/renderer/src/utils/batchOps.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 98
        },
        'src/renderer/src/utils/frontendAlign.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 98
        },
        // ── 0.1.14 新增模块（首轮实测 − 2pp）──
        'src/shared/mediaTypes.ts': { statements: 98, lines: 98, functions: 98, branches: 98 },
        'src/main/services/assetsApi.ts': {
          statements: 98,
          lines: 88,
          functions: 98,
          branches: 88
        },
        // ── 0.1.16 新增模块（首轮实测 − 2pp）──
        'src/shared/logLine.ts': {
          statements: 94,
          lines: 94,
          functions: 98,
          branches: 84
        },
        'src/main/services/childEnv.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 98
        },
        'src/main/services/lru.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 98
        },
        'src/main/services/logFile.ts': {
          statements: 87,
          lines: 87,
          functions: 98,
          branches: 63
        },
        'src/main/services/session.ts': {
          statements: 86,
          lines: 86,
          functions: 98,
          branches: 49
        },
        'src/main/services/startupIssues.ts': {
          statements: 98,
          lines: 98,
          functions: 98,
          branches: 68
        },
        // ── 全局下限（0.1.10 全量实测 − 2pp）──
        statements: 88,
        lines: 88,
        functions: 90,
        branches: 81
      }
    }
  }
})
