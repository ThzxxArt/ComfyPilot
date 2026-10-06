import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.e2e.ts'],
    exclude: ['node_modules/**', 'out/**'],
    testTimeout: 30000,
    hookTimeout: 30000
  }
})
