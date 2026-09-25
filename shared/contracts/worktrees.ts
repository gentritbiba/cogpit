/** A file changed by a worktree relative to its default branch. */
export interface FileChange {
  path: string
  status: "M" | "A" | "D" | "R"
  additions: number
  deletions: number
}

/** A session addressed the way the session routes take it. */
export interface WorktreeSessionRef {
  dirName: string
  sessionId: string
}

/** Browser-safe wire contract returned by GET /api/worktrees/:dirName. */
export interface WorktreeInfo {
  name: string
  path: string
  branch: string
  head: string
  headMessage: string
  isDirty: boolean
  commitsAhead: number
  /** Sessions that ran in the worktree or on its branch, newest first. */
  linkedSessions: WorktreeSessionRef[]
  createdAt: string
  changedFiles: FileChange[]
}
