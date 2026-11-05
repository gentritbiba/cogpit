import { agentReadiness, type AgentCheck } from "../../../shared/contracts/agentCheck"

const DISMISSED_KEY = "cogpit:get-started-dismissed"

/** First tasks that read a project and change nothing, safe for someone trying an agent for the first time. */
export const EXAMPLE_TASKS: readonly string[] = [
  "Explain what this project does and how its files are organized.",
  "Look for bugs or problems and list them. Don't change any files.",
  "Suggest three small improvements I could make first.",
]

export function getStartedDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

export function dismissGetStarted(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, "1")
  } catch {
    // Unsaved, the card shows again next time; the session it leads to hides it for good.
  }
}

/**
 * The getting-started card shows on a new install until its first session
 * exists or the person dismisses it. Installs from before never see it.
 */
export function showsGetStarted({ freshInstall, sessionCount, dismissed }: { freshInstall: boolean; sessionCount: number; dismissed: boolean }): boolean {
  return freshInstall && sessionCount === 0 && !dismissed
}

export interface AgentSummary {
  ready: boolean
  text: string
}

/** One line on whether an agent can take a first task, from the agent check. */
export function agentSummary(agents: readonly AgentCheck[] | null, error: string | null): AgentSummary {
  if (!agents) return { ready: false, text: error ? "Couldn't check your agents." : "Checking your agents…" }
  const named = (readiness: ReturnType<typeof agentReadiness>) =>
    agents.find((agent) => agentReadiness(agent) === readiness)?.displayName
  const ready = named("ready")
  if (ready) return { ready: true, text: `${ready} is ready.` }
  const signedOut = named("signed-out")
  if (signedOut) return { ready: false, text: `${signedOut} is installed. Sign in to use it.` }
  const unknown = named("unknown")
  if (unknown) return { ready: false, text: `${unknown} is installed. Make sure you're signed in.` }
  return { ready: false, text: "No coding agent found on this computer yet." }
}
