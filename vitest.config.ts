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
        'src/main/services/installer.ts',
        'src/shared/constants.ts',
        'src/shared/types.ts'
      ],
      // Hot security paths must stay high; installer runPlan is covered by
      // integration gates + manual install smoke (touched lines tracked here).
      thresholds: {
        lines: 55,
        functions: 55,
        branches: 65,
        statements: 55
      }
    }
  }
})
