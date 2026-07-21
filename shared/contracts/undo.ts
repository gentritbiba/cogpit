/** Compact session mutations used by the atomic undo transaction API. */
export type UndoSessionMutation =
  | { type: "truncate"; keepLines: number; expectedLineCount: number }
  | { type: "append"; lines: string[]; expectedLineCount: number }
  | { type: "splice"; keepLines: number; lines: string[]; expectedLineCount: number }
