/**
 * Test-program globals: declare the preload bridge on Window for the tests
 * tsconfig (src/preload/index.d.ts is not picked up by the include globs).
 * The property type is identical to the preload declaration, so interface
 * merging stays type-compatible if both files land in one program.
 */
import type { ComfyPilotApi } from '../src/preload/index'

declare global {
  interface Window {
    comfyPilot: ComfyPilotApi
  }
}

export {}
