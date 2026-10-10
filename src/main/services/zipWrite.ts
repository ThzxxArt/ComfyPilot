/**
 * Minimal ZIP writer (deflate + store) for workflow / output share bundles.
 * No third-party deps — enough for export-to-zip of small JSON/PNG/text files.
 */
import { readFileSync, writeFileSync, statSync } from 'fs'
import { basename } from 'path'
import { deflateRawSync, crc32 } from 'zlib'

export interface ZipEntry {
  /** Absolute path of an existing file to include. */
  path?: string
  /** Inline text content (mutually exclusive with `path`). */
  content?: string
  /** Name inside the archive. Defaults to basename(path). */
  name: string
}

interface PreparedEntry {
  name: string
  data: Buffer
  crc: number
  method: 0 | 8
  compressed: Buffer
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const d =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: d }
}

function prepare(entry: ZipEntry): PreparedEntry {
  let data: Buffer
  if (entry.path) {
    data = readFileSync(entry.path)
  } else if (entry.content != null) {
    data = Buffer.from(entry.content, 'utf-8')
  } else {
    throw new Error(`Zip entry ${entry.name} has neither path nor content`)
  }
  const name = basename(entry.name).replace(/[\\/]/g, '_')
  const crc = crc32(data) >>> 0
  const deflated = deflateRawSync(data)
  // Only use deflate when it actually shrinks the payload.
  if (deflated.length < data.length) {
    return { name, data, crc, method: 8, compressed: deflated }
  }
  return { name, data, crc, method: 0, compressed: data }
}

/**
 * Write a ZIP archive to `outPath`. Entry names are sanitized to basenames so
 * the archive can never contain path traversal segments.
 *
 * Limits: classic ZIP32 only — refuse payloads that would need ZIP64 rather
 * than silently emitting a corrupt archive.
 */
export function writeZip(outPath: string, entries: ZipEntry[]): string {
  if (!entries.length) throw new Error('Cannot create an empty zip')
  if (entries.length > 0xffff) throw new Error('Too many entries for a classic zip (max 65535)')
  const prepared = entries.map(prepare)
  let totalData = 0
  for (const e of prepared) {
    totalData += e.data.length
    if (e.data.length > 0xffffffff || e.compressed.length > 0xffffffff) {
      throw new Error(`Entry ${e.name} exceeds 4GB — ZIP64 is not supported; export a smaller subset`)
    }
    if (totalData > 0xffffffff) {
      throw new Error('Archive would exceed 4GB — ZIP64 is not supported; export a smaller subset')
    }
  }
  const { time, date } = dosDateTime()

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const e of prepared) {
    const nameBuf = Buffer.from(e.name, 'utf-8')
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 flag
    local.writeUInt16LE(e.method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(e.crc, 14)
    local.writeUInt32LE(e.compressed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    nameBuf.copy(local, 30)
    locals.push(local, e.compressed)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(e.method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(e.crc, 16)
    central.writeUInt32LE(e.compressed.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + e.compressed.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  writeFileSync(outPath, Buffer.concat([...locals, centralBuf, eocd]))
  return outPath
}

/** Convenience wrapper used by workflow export. */
export async function createWorkflowZip(
  outPath: string,
  entries: Array<{ path?: string; name: string; content?: string }>
): Promise<string> {
  // Guard: refuse to pack missing files so the zip is never silently empty.
  for (const e of entries) {
    if (e.path) {
      const st = statSync(e.path)
      if (!st.isFile()) throw new Error(`Not a file: ${e.path}`)
    }
  }
  return writeZip(outPath, entries)
}
