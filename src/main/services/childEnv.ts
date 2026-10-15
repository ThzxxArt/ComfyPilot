/**
 * Environment for any ComfyUI / Python child process (0.1.16).
 *
 * Why this exists: every spawn site used to build `{ ...process.env, ...proxyEnv() }`
 * by hand, and none set UTF-8. On a zh-CN Windows box (system code page GBK)
 * that makes pip's build backend read UTF-8 source as GBK and die with
 * `UnicodeDecodeError: 'gbk' codec can't decode byte 0x92` — exactly the
 * `argos-translate` failure seen in ComfyUI_Custom_Nodes_AlekPet. Forcing
 * Python's UTF-8 mode fixes it without touching the user's system settings.
 *
 * `PYTHONUNBUFFERED=1` additionally keeps stdout/stderr in near-real order so
 * the merged instance log no longer shows blocks of re-ordered timestamps.
 */
import type { AppSettings } from '@shared/types'
import { proxyEnv } from './proxy'

/** UTF-8 / unbuffered overrides applied to every ComfyUI-related child. */
export const PYTHON_UTF8_ENV: Record<string, string> = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONUNBUFFERED: '1'
}

/**
 * Build the child environment: caller's base (defaults to `process.env`),
 * proxy wiring from settings (which itself strips stale proxy vars), then the
 * UTF-8/unbuffered overrides. Never mutates `process.env`.
 */
export function comfyChildEnv(
  settings: Pick<AppSettings, 'proxy'>,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...proxyEnv(settings.proxy, base),
    ...PYTHON_UTF8_ENV
  }
}
