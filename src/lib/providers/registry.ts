import { codexProvider } from "./codex"
import { copilotProvider } from "./copilot"
import { claudeProvider } from "./claude"
import type { AgentKind, SessionProvider } from "./types"

const PROVIDERS = new Map<AgentKind, SessionProvider>([
  ["codex", codexProvider],
  ["copilot", copilotProvider],
  ["claude", claudeProvider],
])

export function getProvider(kind: AgentKind): SessionProvider {
  const provider = PROVIDERS.get(kind)
  if (!provider) throw new Error(`Unknown provider kind: ${kind}`)
  return provider
}

/** Infer the agent kind from a session directory name */
export function inferAgentKind(dirName: string | null | undefined): AgentKind {
  if (codexProvider.isDirName(dirName)) return "codex"
  if (copilotProvider.isDirName(dirName)) return "copilot"
  return "claude"
}

/** Get the provider for a given session directory name */
export function getProviderForDirName(dirName: string | null | undefined): SessionProvider {
  return getProvider(inferAgentKind(dirName))
}

/** Get the provider by inspecting the JSONL content of a session file */
export function getProviderForSessionText(jsonlText: string): SessionProvider {
  if (codexProvider.isSessionText(jsonlText)) return codexProvider
  if (copilotProvider.isSessionText(jsonlText)) return copilotProvider
  return claudeProvider
}
