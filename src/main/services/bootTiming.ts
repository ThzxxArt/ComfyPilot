/**
 * 0.1.18 (WP4): boot phase timings.
 *
 * "Startup feels slow" had no evidence behind it. The app now stamps the
 * three phases that matter — module bootstrap → app ready / window shown →
 * the first data list the renderer requests — into the same `logs/boot.log`
 * the diagnostics bundle already collects. Cheap (a few appends), and it
 * makes a future regression measurable instead of anecdotal.
 */
import { appendFileSync } from 'fs'
import { join } from 'path'
import { logsDir } from './db'

const T0 = Date.now()
let firstListMarked = false

export function bootMark(phase: string): void {
  const line = `[${new Date().toISOString()}] boot: ${phase} +${Date.now() - T0}ms\n`
  try {
    appendFileSync(join(logsDir(), 'boot.log'), line)
  } catch {
    /* diagnostics must never break startup */
  }
}

/** Milliseconds since module bootstrap (main process). */
export function bootElapsed(): number {
  return Date.now() - T0
}

/**
 * The first list call is what the user experiences as "the app is usable".
 * Only the first one is recorded so boot.log stays readable.
 */
export function bootMarkFirstList(channel: string): void {
  if (firstListMarked) return
  firstListMarked = true
  bootMark(`first-list:${channel}`)
}

/** Test helper — allow repeat runs in one process. */
export function resetBootTimingForTest(): void {
  firstListMarked = false
}
