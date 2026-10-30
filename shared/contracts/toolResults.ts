/** The opt-in transcript projection a reader names with `?projection=` on session pages and the live stream. */
export const RESULT_PROJECTION = "results-v1"

/** One response of `GET /api/tool-result`: part of an elided result body, from `start` to `end` of `total` characters. */
export interface ToolResultBodyResponse {
  kind: "text" | "image"
  text: string
  start: number
  end: number
  total: number
}

/** Why a body could not be served: `stale` after the transcript changed, `too_large` past the server's cap. */
export type ToolResultUnavailable = "stale" | "too_large" | "denied" | "invalid" | "error"
