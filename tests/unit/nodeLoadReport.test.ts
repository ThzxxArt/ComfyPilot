/**
 * Boot-log load report parsing (0.1.10) — behaviour over realistic log lines.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseNodeLoadReport,
  packLoadStatusOf,
  packLoadFailureOf,
  packFolderOf
} from '@shared/nodeLoadReport'

const log = (message: string, ts = 0): { message: string; ts: number } => ({ message, ts })

describe('parseNodeLoadReport (0.1.10)', () => {
  it('parses the import block with success and failure rows', () => {
    const report = parseNodeLoadReport([
      log('Total VRAM 24564 MB'),
      log('Import times for custom nodes:', 111),
      log('    0.3 seconds: C:\\ComfyUI\\custom_nodes\\ComfyUI-KJNodes'),
      log('    9.1 seconds (IMPORT FAILED): C:\\ComfyUI\\custom_nodes\\BrokenPack'),
      log(
        'Cannot import C:\\ComfyUI\\custom_nodes\\BrokenPack module for custom nodes: No module named "cv2"'
      ),
      log('Starting server')
    ])
    expect(report).not.toBeNull()
    expect(report!.available).toBe(true)
    expect(report!.observedAt).toBe(111)
    expect(report!.entries).toHaveLength(2)
    expect(report!.entries[0]).toMatchObject({
      folder: 'ComfyUI-KJNodes',
      ok: true,
      prestartup: false
    })
    expect(report!.entries[1]).toMatchObject({ folder: 'BrokenPack', ok: false })
    expect(report!.entries[1].error).toContain('cv2')
  })

  it('parses prestartup failures and keeps sections apart', () => {
    const report = parseNodeLoadReport([
      log('Prestartup times for custom nodes:', 50),
      log('    0.1 seconds (PRESTARTUP FAILED): /opt/ComfyUI/custom_nodes/BadScript'),
      log('Import times for custom nodes:', 60),
      log('    0.2 seconds: /opt/ComfyUI/custom_nodes/GoodPack')
    ])
    expect(report!.entries).toHaveLength(2)
    expect(report!.entries[0]).toMatchObject({
      folder: 'BadScript',
      ok: false,
      prestartup: true
    })
    expect(report!.entries[1]).toMatchObject({ folder: 'GoodPack', ok: true, prestartup: false })
  })

  it('uses the LAST block when the instance booted several times', () => {
    const report = parseNodeLoadReport([
      log('Import times for custom nodes:'),
      log('    5.0 seconds (IMPORT FAILED): C:/c/custom_nodes/Old'),
      log('Import times for custom nodes:'),
      log('    0.1 seconds: C:/c/custom_nodes/New')
    ])
    expect(report!.entries).toHaveLength(1)
    expect(report!.entries[0].folder).toBe('New')
    expect(report!.entries[0].ok).toBe(true)
  })

  it('strips `.disabled` from module folder names', () => {
    const report = parseNodeLoadReport([
      log('Import times for custom nodes:'),
      log('    0.1 seconds: C:/c/custom_nodes/Foo.disabled')
    ])
    expect(report!.entries[0].folder).toBe('Foo')
  })

  it('records the Skip reason for packs without mappings', () => {
    const report = parseNodeLoadReport([
      log('Import times for custom nodes:'),
      log('    1.2 seconds (IMPORT FAILED): C:/c/custom_nodes/NoMap'),
      log(
        'Skip C:/c/custom_nodes/NoMap module for custom nodes due to the lack of NODE_CLASS_MAPPINGS or comfy_entrypoint (need one).'
      )
    ])
    expect(report!.entries[0].error).toContain('NODE_CLASS_MAPPINGS')
  })

  it('returns null when no block exists (rotated logs) — never guesses', () => {
    expect(
      parseNodeLoadReport([
        log('Starting server'),
        log('To see the GUI go to: http://127.0.0.1:8188')
      ])
    ).toBeNull()
  })

  it('packLoadStatusOf matrix: failed wins, prestartup reported, absent → unknown', () => {
    const report = parseNodeLoadReport([
      log('Prestartup times for custom nodes:'),
      log('    0.1 seconds (PRESTARTUP FAILED): C:/c/custom_nodes/Pre'),
      log('Import times for custom nodes:'),
      log('    0.2 seconds: C:/c/custom_nodes/Good'),
      log('    3.0 seconds (IMPORT FAILED): C:/c/custom_nodes/Bad')
    ])
    expect(packLoadStatusOf('Good', report)).toBe('loaded')
    expect(packLoadStatusOf('Bad', report)).toBe('import-failed')
    expect(packLoadStatusOf('Pre', report)).toBe('prestartup-failed')
    expect(packLoadStatusOf('NotInLog', report)).toBe('unknown')
    expect(packLoadStatusOf('Any', null)).toBe('unknown')
    expect(packLoadFailureOf('Bad', report)?.seconds).toBe(3)
    expect(packLoadFailureOf('Good', report)).toBeUndefined()
  })

  it('packFolderOf handles both separators and trailing slashes', () => {
    expect(packFolderOf('C:\\x\\y\\Pack\\')).toBe('Pack')
    expect(packFolderOf('/a/b/Pack.disabled')).toBe('Pack')
    expect(packFolderOf('')).toBe('')
  })

  // ---------- 0.1.11: ComfyUI 0.39 routes these lines through the logging
  // formatter, which ALWAYS prefixes `[LEVEL] ` (with ANSI codes). The old
  // line-anchored regex parsed zero rows and the UI showed "0 ok / 0 failed".
  it('parses ComfyUI 0.39+ lines carrying the [INFO] level prefix (0.1.11)', () => {
    const report = parseNodeLoadReport([
      log('[INFO] Import times for custom nodes:', 200),
      log('[INFO]    0.3 seconds: C:\\ComfyUI\\custom_nodes\\Good'),
      log('\x1b[92m[INFO]\x1b[0m    9.1 seconds (IMPORT FAILED): C:\\ComfyUI\\custom_nodes\\Bad'),
      log(
        '[INFO] Cannot import C:\\ComfyUI\\custom_nodes\\Bad module for custom nodes: No module named "cv2"'
      )
    ])
    expect(report?.available).toBe(true)
    expect(report!.observedAt).toBe(200)
    expect(report!.entries).toHaveLength(2)
    expect(report!.entries[0]).toMatchObject({ folder: 'Good', ok: true })
    const bad = report!.entries.find((e) => e.folder === 'Bad')!
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('cv2')
  })

  it('still parses legacy bare lines and prefixed prestartup blocks (0.1.11)', () => {
    const report = parseNodeLoadReport([
      log('[INFO] Prestartup times for custom nodes:'),
      log('[ERROR]    0.1 seconds (PRESTARTUP FAILED): /x/custom_nodes/PreBad'),
      log('Import times for custom nodes:'),
      log('    0.2 seconds: /x/custom_nodes/LegacyGood')
    ])
    expect(report!.entries.map((e) => e.folder).sort()).toEqual(['LegacyGood', 'PreBad'])
    expect(report!.entries.find((e) => e.folder === 'PreBad')!.prestartup).toBe(true)
    expect(packLoadStatusOf('Good', report)).toBe('unknown')
  })

  it('parses the real fixture log files (0.39 prefixed + legacy bare)', () => {
    const fx = (name: string): Array<{ message: string; ts: number }> =>
      readFileSync(join(__dirname, '..', 'fixtures', name), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((message, i) => ({ message, ts: i }))

    const modern = parseNodeLoadReport(fx('comfy-039-import-times.log'))
    expect(modern?.available).toBe(true)
    expect(modern!.entries).toHaveLength(2)
    const broken = modern!.entries.find((e) => e.folder === 'BrokenPack')!
    expect(broken.ok).toBe(false)
    expect(broken.error).toContain('cv2')

    const legacy = parseNodeLoadReport(fx('comfy-legacy-import-times.log'))
    expect(legacy!.entries).toHaveLength(2)
    expect(legacy!.entries.find((e) => e.folder === 'ComfyUI-KJNodes')!.ok).toBe(true)

    const prestartup = parseNodeLoadReport(fx('comfy-039-prestartup.log'))
    expect(prestartup!.entries.map((e) => e.folder).sort()).toEqual(['GoodPack', 'PreBad'])
  })
})
