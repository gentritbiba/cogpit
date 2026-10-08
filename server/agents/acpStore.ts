import { join } from "node:path"
import { homedir } from "node:os"
import { descriptorFor } from "../../shared/session/agent-descriptors"
import { createClaudeStore } from "./claudeStore"
export function createAcpStore(home = process.env.COGPIT_ACP_HOME || join(homedir(), ".cogpit-acp")) {
  return createClaudeStore(join(home, "projects"), descriptorFor("acp"))
}
export const acpStore = createAcpStore()
