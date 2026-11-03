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
      const floor = (v?: number): number =>
        typeof v === 'number' ? Math.max(0, Math.floor(v - 2)) : 0
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
    // Istanbul adds instrumentation overhead to heavily dynamic imports
    // (IPC registration); 15s was too close to the edge on slower runners.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'out/**'],
    coverage: {
      // Istanbul is deterministic across workers/runners. The V8 provider
      // under-counted anonymous functions on GitHub Actions (a test-only
      // environment difference), which made the per-file floors flaky.
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // 0.2.3: measure the WHOLE runtime surface, not a hand-picked subset.
      // Every main/preload/shared/renderer module and Vue component is in the
      // denominator. Only type declarations and the CJS process bootstrap
      // (exercised by the real-Electron E2E) are excluded.
      include: [
        'src/main/**/*.ts',
        'src/shared/**/*.ts',
        'src/preload/**/*.ts',
        'src/renderer/src/**/*.ts',
        'src/renderer/src/**/*.vue'
      ],
      exclude: [
        'src/**/*.d.ts',
        'src/renderer/src/env.d.ts',
        // Last-resort startup shim loaded by Electron before any test runtime.
        'src/main/bootstrap.cjs'
      ],
      thresholds: {
        // Derived per file (baseline − 2pp) + a global floor.
        ...perFileThresholds(),
        // 0.2.3: denominator is the WHOLE runtime surface (main, preload,
        // shared, renderer views/components/stores). Measured on that
        // denominator: statements 64.32 / branches 53.40 / functions 49.27 /
        // lines 66.53 → floors are actual − 2pp. The number is lower than the
        // old hand-picked subset, but it now covers 100% of runtime files.
        statements: 62,
        lines: 64,
        functions: 47,
        branches: 51
      }
    }
  }
})
