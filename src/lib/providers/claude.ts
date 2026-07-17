import { isCodexSessionText } from "../codex"
import type { SessionProvider, PermissionsConfig } from "./types"

// ── Directory name helpers ────────────────────────────────────────────────────

export function isClaudeDirName(dirName: string | null | undefined): boolean {
  return typeof dirName === "string" && !dirName.startsWith("codex__")
}

/** Encode a cwd using Claude Code's project-directory naming convention. */
export function encodeClaudeDirName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "") || cwd
  return normalized.replace(/[:\\/]/g, "-")
}

// ── CLI arg builders ──────────────────────────────────────────────────────────

export function buildClaudePermArgs(permissions?: PermissionsConfig): string[] {
  if (!permissions || !permissions.mode) {
    return ["--permission-mode", "default"]
  }
  if (permissions.mode === "bypassPermissions") {
    return ["--dangerously-skip-permissions"]
  }

  const args: string[] = []

  const modeMap: Record<string, string> = {
    default: "default",
    plan: "plan",
    acceptEdits: "acceptEdits",
    dontAsk: "dontAsk",
    auto: "auto",
  }
  const mapped = modeMap[permissions.mode]
  if (mapped) {
    args.push("--permission-mode", mapped)
  }

  if (permissions.allowedTools) {
    for (const tool of permissions.allowedTools) {
      args.push("--allowedTools", tool)
    }
  }

  if (permissions.disallowedTools) {
    for (const tool of permissions.disallowedTools) {
      args.push("--disallowedTools", tool)
    }
  }

  return args
}

export function buildClaudeModelArgs(model?: string): string[] {
  return model ? ["--model", model] : []
}

// ── Resume command ────────────────────────────────────────────────────────────

export function getClaudeResumeCommand(sessionId: string, _cwd?: string): string {
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
  buildEffortArgs: (effort) => effort ? ["--effort", effort] : [],
}
