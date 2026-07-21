import { isCodexSessionText } from "../codex"
import type { SessionProvider } from "../../../shared/providers/types"
import { CODEX_PREFIX } from "../../../shared/providers/codex"
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
  return typeof dirName === "string" && !dirName.startsWith(CODEX_PREFIX)
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
  buildEffortArgs: buildClaudeEffortArgs,
}
