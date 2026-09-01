import { isCopilotSessionText } from "../../../shared/session/copilot"
import type { SessionProvider } from "../../../shared/providers/types"
import {
  buildCopilotEffortArgs,
  buildCopilotModelArgs,
  buildCopilotPermArgs,
  isCopilotDirName,
} from "../../../shared/providers/copilot"

export {
  COPILOT_PREFIX,
  buildCopilotEffortArgs,
  buildCopilotModelArgs,
  buildCopilotPermArgs,
  decodeCopilotDirName,
  encodeCopilotDirName,
  isCopilotDirName,
} from "../../../shared/providers/copilot"

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function getCopilotResumeCommand(sessionId: string, cwd?: string): string {
  return cwd
    ? `copilot -C ${shellQuote(cwd)} --resume ${sessionId}`
    : `copilot --resume ${sessionId}`
}

export const copilotProvider: SessionProvider = {
  kind: "copilot",
  isDirName: isCopilotDirName,
  isSessionText: isCopilotSessionText,
  resumeCommand: getCopilotResumeCommand,
  buildPermArgs: buildCopilotPermArgs,
  buildModelArgs: buildCopilotModelArgs,
  buildEffortArgs: buildCopilotEffortArgs,
}
