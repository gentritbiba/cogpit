/** Set by `cogpitAgentEnv` for agents. A server started inside an agent must not share its parent's orchestration store and dispatcher lease. */
const PARENT_CONTEXT = ["COGPIT_SESSION_ID", "COGPIT_ORCHESTRATION_ROOT"] as const

export function detachFromParentCogpit(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.COGPIT_SESSION_ID) return
  for (const key of PARENT_CONTEXT) delete env[key]
}
