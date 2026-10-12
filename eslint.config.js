import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import ts from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import vueParser from 'vue-eslint-parser'
import prettier from '@vue/eslint-config-prettier'

/** Node / Web globals used across main process, scripts and tests. */
const nodeGlobals = {
  process: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  global: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  WebSocket: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  performance: 'readonly',
  crypto: 'readonly'
}

export default [
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { globals: nodeGlobals }
  },
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parser: tsParser,
      globals: nodeGlobals,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue']
      }
    },
    plugins: { '@typescript-eslint': ts },
    rules: {
      'vue/multi-word-component-names': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      // typescript-eslint 官方建议：TS 代码由编译器负责未定义标识符检查
      'no-undef': 'off',
      // 基础 no-unused-vars 对 TS 误报；交给 typescript-eslint 版本
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // Vue SFC 必须由 vue-eslint-parser 解析（内部再委托 TS parser 处理 <script lang="ts">）
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      globals: nodeGlobals,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue']
      }
    }
  },
  prettier
]
