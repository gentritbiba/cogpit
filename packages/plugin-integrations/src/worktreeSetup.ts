export type WorktreeSetupStage = "initializing" | "setup" | "failed" | "agent-start" | "ready" | "cancelled" | "interrupted"

export interface WorktreeSetupRecipe {
  command: string
  timeoutMs: number
  revision: string
  configuredAt: number
}

/** One startup as a plugin sees it: no host paths or session ids. */
export interface WorktreeSetupOperation {
  id: string
  worktreeName: string
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
  recipe: WorktreeSetupRecipe | null
  operations: WorktreeSetupOperation[]
}

/** A recipe change waiting for the user's confirmation in Cogpit's own dialog. */
export interface WorktreeSetupProposal { proposalId: string }

export const WORKTREE_SETUP_COMMAND_LIMIT = 8000
export const WORKTREE_SETUP_OUTPUT_LIMIT = 64_000
export const WORKTREE_SETUP_DEFAULT_TIMEOUT_MS = 10 * 60_000
export const WORKTREE_SETUP_MAX_TIMEOUT_MS = 60 * 60_000
export const worktreeSetupActive = (stage: WorktreeSetupStage): boolean =>
  stage === "initializing" || stage === "setup" || stage === "failed" || stage === "agent-start"
