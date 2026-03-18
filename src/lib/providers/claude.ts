import { isCodexSessionText } from "../codex"
import type { SessionProvider, PermissionsConfig } from "./types"

// ── Directory name helpers ────────────────────────────────────────────────────

export function isClaudeDirName(dirName: string | null | undefined): boolean {
  return typeof dirName === "string" && !dirName.startsWith("codex__")
}

// ── CLI arg builders ──────────────────────────────────────────────────────────

/**
 * Build Claude CLI permission arguments.
 * Auto-approves ExitPlanMode and AskUserQuestion for non-bypass modes
 * since these interactive tools can't receive stdin approval through
 * stream-json user messages (causes an infinite retry loop in -p mode).
 */
export function buildClaudePermArgs(permissions?: PermissionsConfig): string[] {
  if (permissions && typeof permissions.mode === "string" && permissions.mode !== "bypassPermissions") {
    const args = ["--permission-mode", permissions.mode]
    if (Array.isArray(permissions.allowedTools)) {
      for (const tool of permissions.allowedTools) args.push("--allowedTools", tool)
    }
    if (Array.isArray(permissions.disallowedTools)) {
      for (const tool of permissions.disallowedTools) args.push("--disallowedTools", tool)
    }
    args.push("--allowedTools", "ExitPlanMode")
    args.push("--allowedTools", "AskUserQuestion")
    return args
  }
  return ["--dangerously-skip-permissions"]
}

export function buildClaudeModelArgs(model?: string): string[] {
  return model ? ["--model", model] : []
}

// ── Resume command ────────────────────────────────────────────────────────────

export function getClaudeResumeCommand(sessionId: string): string {
  return `claude --resume ${sessionId}`
}

// ── Provider object ───────────────────────────────────────────────────────────

export const claudeProvider: SessionProvider = {
  kind: "claude",
  isDirName: isClaudeDirName,
  isSessionText: (text) => !isCodexSessionText(text),
  resumeCommand: getClaudeResumeCommand,
  buildPermArgs: buildClaudePermArgs,
  buildModelArgs: buildClaudeModelArgs,
  buildEffortArgs: () => [], // Claude CLI has no effort argument
}
