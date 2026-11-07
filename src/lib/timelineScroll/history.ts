/** The history reserve never estimates more than this many viewports. */
const RESERVE_MAX_VIEWPORTS = 12
/** Reserve while the history's density is not known yet. */
const RESERVE_FALLBACK_VIEWPORTS = 3
/** Older history loads while the first loaded row is within this many viewports of the viewport top. */
const LOAD_TRIGGER_VIEWPORTS = 3

interface ReserveInput {
  hasMore: boolean
  viewport: number
  /** Bytes of transcript before the paging cursor. */
  remainingBytes: number
  /** Bytes of transcript the loaded rows came from. */
  loadedBytes: number
  /** Estimated height of every loaded row. */
  loadedHeight: number
}

/** Space above the loaded rows standing in for the history not loaded yet. */
export function reserveHeight({ hasMore, viewport, remainingBytes, loadedBytes, loadedHeight }: ReserveInput): number {
  if (!hasMore || viewport <= 0) return 0
  const cap = viewport * RESERVE_MAX_VIEWPORTS
  if (loadedBytes <= 0 || loadedHeight <= 0 || remainingBytes <= 0) return viewport * RESERVE_FALLBACK_VIEWPORTS
  return Math.min(cap, Math.round(remainingBytes * (loadedHeight / loadedBytes)))
}

interface TriggerInput {
  hasMore: boolean
  loading: boolean
  /** The open placement has landed; paging before it would read a meaningless scroll position. */
  placed: boolean
  viewport: number
  viewTop: number
  /** Content offset of the first loaded row, measured or estimated. */
  firstRowTop: number
}

export function shouldLoadOlder({ hasMore, loading, placed, viewport, viewTop, firstRowTop }: TriggerInput): boolean {
  if (!hasMore || loading || !placed || viewport <= 0) return false
  return viewTop - firstRowTop <= viewport * LOAD_TRIGGER_VIEWPORTS
}
