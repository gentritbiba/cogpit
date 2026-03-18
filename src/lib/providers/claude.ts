import { isCodexSessionText } from "../codex"
import type { SessionProvider, PermissionsConfig } from "./types"

// ── Directory name helpers ────────────────────────────────────────────────────

export function isClaudeDirName(dirName: string | null | undefined): boolean {
  return typeof dirName === "string" && !dirName.startsWith("codex__")
}

// ── CLI arg builders ──────────────────────────────────────────────────────────

export function buildClaudePermArgs(permissions?: PermissionsConfig): string[] {
  void permissions
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
  buildEffortArgs: (effort) => effort ? ["--effort", effort] : [],
}
