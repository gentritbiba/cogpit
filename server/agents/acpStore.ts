import { join } from "node:path"
import { homedir } from "node:os"
import { ANTIGRAVITY_TRANSCRIPTS_DIR, descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import { createClaudeStore } from "./claudeStore"

/** The transcripts Cogpit writes for an ACP agent, under that agent's own home. */
function acpTranscriptStore(kind: AgentKind, transcriptsDir: string) {
  const descriptor = descriptorFor(kind)
  const { homeEnvVar, homeDirName } = descriptor.cli
  return (home = (homeEnvVar && process.env[homeEnvVar]) || join(homedir(), homeDirName)) => createClaudeStore(join(home, transcriptsDir), descriptor)
}

export const createAcpStore = acpTranscriptStore("acp", "projects")
export const acpStore = createAcpStore()
export const createAntigravityStore = acpTranscriptStore("antigravity", ANTIGRAVITY_TRANSCRIPTS_DIR)
export const antigravityStore = createAntigravityStore()
