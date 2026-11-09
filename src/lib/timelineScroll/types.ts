export interface TimelineViewport {
  firstVisibleKey: string | null
  atBottom: boolean
}

export interface ScrollToTurnOptions {
  align?: "start" | "center"
  /** The element inside the turn's row to land on; the row itself when absent or null. */
  target?: (row: HTMLElement) => Element | null
}

/** What sits over the timeline uses to read and move it; the engine is the only scroll writer. */
export interface TimelineHandle {
  /** Resolves false when no loaded turn has that key. */
  scrollToTurn(turnKey: string, opts?: ScrollToTurnOptions): Promise<boolean>
  scrollToBottom(): void
  /** Called after scroll or range changes, at most once per frame. */
  subscribe(listener: () => void): () => void
  getViewport(): TimelineViewport
}
