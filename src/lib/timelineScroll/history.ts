/** The history reserve never estimates more than this many viewports. */
const RESERVE_MAX_VIEWPORTS = 12
/** Reserve while the history's density is not known yet. */
const RESERVE_FALLBACK_VIEWPORTS = 3
/** Older history loads while the first loaded row is within this many viewports of the viewport top. */
const LOAD_TRIGGER_VIEWPORTS = 3
/**
 * Reserve while needed history is late (a slow or queued request, a failed
 * page waiting to retry): room for the loading status, so the reader stops at
 * the loaded top instead of scrolling into placeholder.
 */
export const LATE_RESERVE = 48
/** History needed for this long without arriving is late. */
export const HISTORY_LATE_MS = 500

interface ReserveInput {
  hasMore: boolean
  viewport: number
  /** Bytes of transcript before the paging cursor. */
  remainingBytes: number
  /** Bytes of transcript the loaded rows came from. */
  loadedBytes: number
  /** Estimated height of every loaded row. */
  loadedHeight: number
  /** Needed history is late; see `LATE_RESERVE`. */
  late?: boolean
}

/** Space above the loaded rows standing in for the history not loaded yet. */
export function reserveHeight({ hasMore, viewport, remainingBytes, loadedBytes, loadedHeight, late = false }: ReserveInput): number {
  if (!hasMore || viewport <= 0) return 0
  const cap = late ? LATE_RESERVE : viewport * RESERVE_MAX_VIEWPORTS
  if (loadedBytes <= 0 || loadedHeight <= 0 || remainingBytes <= 0) return Math.min(cap, viewport * RESERVE_FALLBACK_VIEWPORTS)
  return Math.min(cap, Math.round(remainingBytes * (loadedHeight / loadedBytes)))
}

interface NeedInput {
  hasMore: boolean
  /** The open placement has landed; paging before it would read a meaningless scroll position. */
  placed: boolean
  viewport: number
  viewTop: number
  /** Content offset of the first loaded row, measured or estimated. */
  firstRowTop: number
}

/** The reader is close enough to the first loaded row that older history should be here or on its way. */
export function historyNeeded({ hasMore, placed, viewport, viewTop, firstRowTop }: NeedInput): boolean {
  if (!hasMore || !placed || viewport <= 0) return false
  return viewTop - firstRowTop <= viewport * LOAD_TRIGGER_VIEWPORTS
}

