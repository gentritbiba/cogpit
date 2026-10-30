/** When a worktree startup re-checks the caller's authority: before preparing the worktree, and before the first provider input. */
export interface StartupAuthorizationContext {
  stage: "setup" | "agent-start"
  cwd: string
  projectCwd: string
  sessionId?: string
}

/** A worktree startup that is still running, as the composer shows it while the first prompt waits. */
export interface ActiveWorktreeStartup {
  id: string
  worktreeName: string
  stage: "initializing" | "extension" | "agent-start"
  /** The plugin preparing the worktree, while `stage` is `extension`. */
  extension?: { pluginId: string; name: string }
  createdAt: number
}
