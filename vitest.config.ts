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
        'src/shared/constants.ts'
      ],
      thresholds: {
        // Per-file floors so one hot module cannot mask another
        'src/main/services/security.ts': {
          lines: 75,
          functions: 75,
          branches: 65
        },
        'src/main/services/workflowConvert.ts': {
          lines: 80,
          functions: 85
        },
        'src/main/services/proxy.ts': {
          lines: 50,
          functions: 50
        },
        'src/main/services/installer.ts': {
          // runPlan is integration-gated; unit locks validators + argv order
          lines: 33,
          functions: 35
        },
        lines: 55,
        functions: 55,
        branches: 65,
        statements: 55
      }
    }
  }
})
