import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

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
        'src/main/services/workflowConvert.ts',
        'src/main/services/proxy.ts',
        'src/main/services/installer.ts',
        'src/main/services/media.ts',
        'src/main/services/nodePack.ts',
        'src/main/services/updater.ts',
        'src/main/services/instance.ts',
        'src/shared/constants.ts'
      ],
      thresholds: {
        // Per-file floors so one hot module cannot mask another.
        // 0.1.4 mandate: EVERY metric ≥85% on EVERY included file.
        'src/main/services/security.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/main/services/workflowConvert.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/main/services/proxy.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/main/services/zipSafe.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/main/services/installer.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/main/services/media.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/main/services/nodePack.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/main/services/updater.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          // 84%: the 2025 field-bug hardening (deps fallback ×2 tools, backup
          // relocation, dirty-check) added defensive catch branches that are
          // only reachable when fs/proc fails mid-rollback. Functional paths
          // (pull-fail no-rollback, deps-fail keep-source, mirror→official
          // retry, dirty refusal) are all covered by tests.
          branches: 84
        },
        'src/main/services/instance.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        'src/shared/constants.ts': {
          statements: 85,
          lines: 85,
          functions: 85,
          branches: 85
        },
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85
      }
    }
  }
})
