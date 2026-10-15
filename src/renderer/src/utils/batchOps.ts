/**
 * Sequential batch-operation runner (0.1.15).
 *
 * The shared "select many → act on each → report exactly" contract behind the
 * output library's batch delete and the model library's batch delete / move.
 * One item failing never aborts the rest; callers render the honest ok/failed
 * split — there is no all-or-nothing shortcut and no fabricated success.
 */

export interface BatchOpItem {
  id: string
  /** Display label used in failure reports (file / model name). */
  label: string
}

export interface BatchOpOutcome {
  ok: number
  failed: Array<{ id: string; label: string; error: string }>
}

export async function runBatchOps(
  items: BatchOpItem[],
  op: (item: BatchOpItem) => Promise<void>
): Promise<BatchOpOutcome> {
  let ok = 0
  const failed: BatchOpOutcome['failed'] = []
  for (const item of items) {
    try {
      await op(item)
      ok += 1
    } catch (e) {
      failed.push({
        id: item.id,
        label: item.label,
        error: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return { ok, failed }
}

/**
 * Which open viewers must close after a batch removal (0.1.15): the detail
 * panel / lightbox when their asset id is inside the removed set. Pure so the
 * linkage contract is unit-tested without a DOM.
 */
export function viewersCloseAfterRemoval(
  ids: string[],
  detailId: string | null | undefined,
  lightboxId: string | null | undefined
): { closeDetail: boolean; closeLightbox: boolean } {
  const removed = new Set(ids)
  return {
    closeDetail: Boolean(detailId && removed.has(detailId)),
    closeLightbox: Boolean(lightboxId && removed.has(lightboxId))
  }
}
