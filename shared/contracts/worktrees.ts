/** A file changed by a worktree relative to its default branch. */
export interface FileChange {
  path: string
  status: "M" | "A" | "D" | "R"
  additions: number
  deletions: number
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
  linkedSessions: string[]
  createdAt: string
  changedFiles: FileChange[]
}
