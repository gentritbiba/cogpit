import { BROWSER_CONTEXT_APPEND } from "../browser/agentContext"
import { agentBinInstalled, cogpitAgentEnv, browserShimInstalled } from "../browser/agentEnv"
import { NO_COGPIT_SESSION } from "../browser/paths"
import { MEDIA_CONTEXT_APPEND } from "./replyContext"

interface SessionConfigClient {
  call<T>(method: string, params?: unknown): Promise<T>
}

interface EffectiveConfig {
  developer_instructions?: string | null
  shell_environment_policy?: { set?: { PATH?: string } }
}

/** Config overrides that give a Codex thread Cogpit's tools and guidance. */
export async function codexSessionConfig(
  client: SessionConfigClient,
  cwd: string,
  sessionId = NO_COGPIT_SESSION,
): Promise<Record<string, string>> {
  const { config } = await client.call<{ config: EffectiveConfig }>("config/read", { cwd })
  // Setting developer_instructions replaces the user's own, so they lead.
  const developerInstructions = [
    config.developer_instructions,
    MEDIA_CONTEXT_APPEND,
    browserShimInstalled() ? BROWSER_CONTEXT_APPEND : null,
  ].filter(Boolean).join("\n\n")
  if (!agentBinInstalled()) return { developer_instructions: developerInstructions }
  const env = cogpitAgentEnv({
    ...process.env,
    PATH: config.shell_environment_policy?.set?.PATH ?? process.env.PATH,
  }, sessionId)
  return {
    // Explicit shell overrides are reapplied after Codex loads its shell snapshot.
    "shell_environment_policy.set.PATH": env.PATH!,
    "shell_environment_policy.set.COGPIT_SESSION_ID": sessionId,
    ...(env.COGPIT_PORT ? { "shell_environment_policy.set.COGPIT_PORT": env.COGPIT_PORT } : {}),
    developer_instructions: developerInstructions,
  }
}
