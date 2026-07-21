export type AgentKind = "claude" | "codex"

export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex"]

export interface PermissionsConfig {
  mode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
}

/**
 * Runtime-neutral provider contract. Session-content detection can stay in a
 * runtime-specific provider while callers share one stable interface.
 */
export interface SessionProvider {
  readonly kind: AgentKind
  /** Returns true when dirName belongs to this provider. */
  isDirName(dirName: string | null | undefined): boolean
  /** Returns true when the JSONL text was produced by this provider. */
  isSessionText(jsonlText: string): boolean
  /** CLI command to resume a session by ID. */
  resumeCommand(sessionId: string, cwd?: string): string
  /** Build CLI permission arguments. */
  buildPermArgs(permissions?: PermissionsConfig): string[]
  /** Build CLI model selection arguments. */
  buildModelArgs(model?: string): string[]
  /** Build CLI effort arguments (no-op for providers that don't support it). */
  buildEffortArgs(effort?: string): string[]
}
