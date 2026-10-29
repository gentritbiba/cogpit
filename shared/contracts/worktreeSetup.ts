export type WorktreeSetupStage = "initializing" | "setup" | "failed" | "agent-start" | "ready" | "cancelled" | "interrupted"

export interface WorktreeSetupRecipe {
  command: string
  timeoutMs: number
  revision: string
  configuredAt: number
}

export interface WorktreeSetupOperation {
  id: string
  projectCwd: string
  worktreeName: string
  cwd?: string
  sessionId?: string
  stage: WorktreeSetupStage
  command?: string
  attempt: number
  output: string
  outputTruncated: boolean
  exitCode?: number | null
  error?: string
  createdAt: number
  updatedAt: number
}

export interface WorktreeSetupSnapshot {
  projectCwd: string
  recipe: WorktreeSetupRecipe | null
  operations: WorktreeSetupOperation[]
}

export interface StartupAuthorizationContext {
  stage: "setup" | "agent-start"
  cwd: string
  projectCwd: string
  sessionId?: string
}

export const WORKTREE_SETUP_OUTPUT_LIMIT = 64_000
export const WORKTREE_SETUP_DEFAULT_TIMEOUT_MS = 10 * 60_000
export const WORKTREE_SETUP_MAX_TIMEOUT_MS = 60 * 60_000
export const worktreeSetupActive = (stage: WorktreeSetupStage): boolean =>
  stage === "initializing" || stage === "setup" || stage === "failed" || stage === "agent-start"
