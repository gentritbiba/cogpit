import { BROWSER_CONTEXT_APPEND } from "../browser/agentContext"
import { browserAgentEnv, browserShimInstalled } from "../browser/agentEnv"
import { NO_COGPIT_SESSION } from "../browser/paths"

interface BrowserConfigClient {
  call<T>(method: string, params?: unknown): Promise<T>
}

interface EffectiveConfig {
  developer_instructions?: string | null
  shell_environment_policy?: { set?: { PATH?: string } }
}

export async function codexBrowserConfig(
  client: BrowserConfigClient,
  cwd: string,
  sessionId = NO_COGPIT_SESSION,
): Promise<Record<string, string>> {
  if (!browserShimInstalled()) return {}
  const { config } = await client.call<{ config: EffectiveConfig }>("config/read", { cwd })
  const env = browserAgentEnv({
    ...process.env,
    PATH: config.shell_environment_policy?.set?.PATH ?? process.env.PATH,
  }, sessionId)
  return {
    // Explicit shell overrides are reapplied after Codex loads its shell snapshot.
    "shell_environment_policy.set.PATH": env.PATH!,
    "shell_environment_policy.set.COGPIT_SESSION_ID": sessionId,
    developer_instructions: [config.developer_instructions, BROWSER_CONTEXT_APPEND].filter(Boolean).join("\n\n"),
  }
}
