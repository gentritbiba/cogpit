import { isCodexSessionText } from "../codex"
import type { SessionProvider } from "../../../shared/providers/types"
import {
  buildCodexEffortArgs,
  buildCodexModelArgs,
  buildCodexPermArgs,
  isCodexDirName,
} from "../../../shared/providers/codex"

export {
  CODEX_PREFIX,
  buildCodexEffortArgs,
  buildCodexFastModeArgs,
  buildCodexModelArgs,
  buildCodexPermArgs,
  decodeCodexDirName,
  encodeCodexDirName,
  isCodexDirName,
} from "../../../shared/providers/codex"

// ── Resume command ────────────────────────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function getCodexResumeCommand(sessionId: string, cwd?: string): string {
  return cwd
    ? `codex -C ${shellQuote(cwd)} resume ${sessionId}`
    : `codex resume ${sessionId}`
}

// ── Provider object ───────────────────────────────────────────────────────────

export const codexProvider: SessionProvider = {
  kind: "codex",
  isDirName: isCodexDirName,
  isSessionText: isCodexSessionText,
  resumeCommand: getCodexResumeCommand,
  buildPermArgs: buildCodexPermArgs,
  buildModelArgs: buildCodexModelArgs,
  buildEffortArgs: buildCodexEffortArgs,
}
