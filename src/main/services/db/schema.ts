/**
 * 0.2.0 data schema. Files are written as:
 *   arrays:  { "schemaVersion": 2, "items": [...] }
 *   objects: { "schemaVersion": 2, ...object }
 * v1 files are migrated exactly once; after that 0.2.0 refuses to read them.
 */
export const DATA_SCHEMA_VERSION = 2

export function isV2Envelope(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).schemaVersion === DATA_SCHEMA_VERSION
  )
}

/** Wrap any value into the v2 on-disk envelope. */
export function toV2(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { schemaVersion: DATA_SCHEMA_VERSION, items: value }
  }
  if (value && typeof value === 'object') {
    return { schemaVersion: DATA_SCHEMA_VERSION, ...(value as Record<string, unknown>) }
  }
  return { schemaVersion: DATA_SCHEMA_VERSION, value }
}

/** Unwrap a v2 envelope back to the in-memory shape. */
export function fromV2<T>(value: unknown): T {
  if (Array.isArray(value)) return value as T
  if (isV2Envelope(value)) {
    if (Array.isArray(value.items)) return value.items as T
    const { schemaVersion: _schema, ...rest } = value
    return rest as T
  }
  throw new Error('DATA_SCHEMA_V1_REJECTED')
}
