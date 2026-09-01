import { isCodexSessionText } from "../codex"
import { isCopilotSessionText } from "../../../shared/session/copilot"
import type { SessionProvider } from "../../../shared/providers/types"
import { isCodexDirName } from "../../../shared/providers/codex"
import { isCopilotDirName } from "../../../shared/providers/copilot"
import {
  buildClaudeEffortArgs,
  buildClaudeModelArgs,
  buildClaudePermArgs,
} from "../../../shared/providers/claude"

export {
  buildClaudeEffortArgs,
  buildClaudeModelArgs,
  buildClaudePermArgs,
  encodeClaudeDirName,
} from "../../../shared/providers/claude"

// ── Directory name helpers ────────────────────────────────────────────────────

export function isClaudeDirName(dirName: string | null | undefined): boolean {
  return typeof dirName === "string" && !isCodexDirName(dirName) && !isCopilotDirName(dirName)
}

// ── Resume command ────────────────────────────────────────────────────────────

export function getClaudeResumeCommand(sessionId: string, _cwd?: string): string {
  return `claude --resume ${sessionId}`
}

// ── Provider object ───────────────────────────────────────────────────────────

export const claudeProvider: SessionProvider = {
  kind: "claude",
  isDirName: isClaudeDirName,
  isSessionText: (text) => !isCodexSessionText(text) && !isCopilotSessionText(text),
  resumeCommand: getClaudeResumeCommand,
  buildPermArgs: buildClaudePermArgs,
  buildModelArgs: buildClaudeModelArgs,
  buildEffortArgs: buildClaudeEffortArgs,
}
