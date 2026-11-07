/**
 * Live session stream v2 (`GET /api/watch/:dirName/:fileName?stream=2`).
 *
 * Opt-in: a request without `stream=2` gets the v1 events (`lines` with
 * `bytes`/`skippedBytes`), which older clients and the iOS app count on.
 */
export const WATCH_STREAM_VERSION = "2"

/** How far behind the file a v2 client may resume before the server sends a `gap` reset instead. */
export const WATCH_GAP_RESET_BYTES = 2 * 1024 * 1024

/**
 * Lines covering native bytes `start` to `end` of the transcript. `end` is
 * always on a line boundary, so a client resumes exactly there. A line sent
 * before its newline was written counts that newline already, so `end` may be
 * one past the file's current size.
 */
export interface WatchLinesEvent {
  type: "lines"
  lines: string[]
  start: number
  end: number
}

export type WatchResetReason = "truncated" | "gap"

/**
 * The stream cannot continue from where the client is: the file shrank below
 * it (`truncated`), or it is too far behind to catch up line by line (`gap`).
 * Nothing more is sent on this connection; the client reloads the session.
 */
export interface WatchResetEvent {
  type: "reset"
  reason: WatchResetReason
}

export interface WatchInitEvent {
  type: "init"
  offset: number
  size: number
  recentlyActive: boolean
}
