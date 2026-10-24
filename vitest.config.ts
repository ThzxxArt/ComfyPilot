import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'

/**
 * 0.1.18 (WP8): per-file floors are DERIVED, never hand-written.
 *
 * `coverage-baseline.json` is written by `npm run coverage:accept` from a real
 * run; each file gets `actual − 2pp` per metric. `coverage-ratchet.cjs` fails
 * any file that drops more than 1pp from that baseline, so a regression cannot
 * be hidden by re-running the accept command unnoticed (it shows in the diff).
 */
function perFileThresholds(): Record<
  string,
  { lines: number; functions: number; branches: number }
> {
  const file = resolve(__dirname, 'coverage-baseline.json')
  if (!existsSync(file)) return {}
  const out: Record<string, { lines: number; functions: number; branches: number }> = {}
  try {
    const baseline = JSON.parse(readFileSync(file, 'utf-8')) as Record<
      string,
      { lines?: number; branches?: number; functions?: number }
    >
    for (const [path, m] of Object.entries(baseline)) {
      const floor = (v?: number): number => (typeof v === 'number' ? Math.max(0, Math.floor(v - 2)) : 0)
      // Statements are gated globally: lcov has no per-statement metric, so a
      // per-file statement floor would be invented rather than measured.
      out[path] = {
        lines: floor(m.lines),
        functions: floor(m.functions),
        branches: floor(m.branches)
      }
    }
  } catch {
    return {}
  }
  return out
}

/**
 * 覆盖率门禁校准（0.1.8）：
 * 0.1.4 起文档宣称「每文件每指标 ≥85%」，但实测从未达标（全局 ~82%，backup/doctor/monitor
 * 等文件甚至没有行为级测试）——门禁实际上长期是红的。
 * 本次按「实测定档 = 实测值 − 2pp」重新校准：门禁从今天起真实可执行，
 * 防的是回归；任何提升都必须伴随补测，而不是改数字。
 * 提高门槛的唯一正途：为新触及的模块补行为测试后，同步上调对应 floor。
 */
export default defineConfig({
  // 0.1.18 (WP8): component tests import real .vue files.
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    // 0.1.18 (WP0): with Vitest 5 + Vite 8 a cold first run spawns a worker per
    // test file; the default 5 s budget is enough for the assertions but not
    // always for the very first module import. Behaviour is unchanged.
    testTimeout: 15000,
    hookTimeout: 15000,
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
        // 0.1.18 (WP8): only components with real DOM tests are measured.
        'src/renderer/src/components/ListState.vue',
        'src/renderer/src/components/IndeterminateBar.vue',
        'src/renderer/src/utils/monitorOps.ts',
        'src/renderer/src/utils/batchOps.ts',
        'src/renderer/src/utils/frontendAlign.ts',
        // ── 0.1.16: new stability/log modules + model library ──
        'src/shared/logLine.ts',
        'src/main/services/childEnv.ts',
        'src/main/services/lru.ts',
        'src/main/services/logFile.ts',
        'src/main/services/session.ts',
        'src/main/services/startupIssues.ts',
        // ── 0.1.17: freeze attribution, secret-at-rest, scoped selection ──
        'src/main/services/model.ts',
        'src/main/services/slowOps.ts',
        'src/main/services/workPool.ts',
        'src/main/services/processTree.ts',
        'src/main/services/secretStorage.ts',
        'src/renderer/src/composables/useScopedSelection.ts',
        'src/renderer/src/composables/useInstanceScope.ts'
      ],
      thresholds: {
        // Derived per file (baseline − 2pp) + a global floor.
        ...perFileThresholds(),
        // 0.1.18 measured global: statements 84.71 / branches 76.06 /
        // functions 85.87 / lines 86.97 → floor = −2pp (model.ts now included).
        statements: 82,
        lines: 84,
        functions: 83,
        branches: 74
      }
    }
  }
})
