import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/Spinner"
import type { AgentCheckState } from "@/hooks/useAgentCheck"
import { startAgentSignIn, useCanRunSignIn } from "@/lib/agents/signIn"
import { AgentCheckList, type SignInHandler } from "./AgentCheckList"

/**
 * The agent rows, a placeholder while the first check runs, and its error.
 * Where Cogpit's terminal panel can run it, Sign in opens the agent's own
 * login there; `onSignInStarted` lets a dialog step aside so it can be seen.
 */
export function AgentCheckView({ check, onSignInStarted }: { check: AgentCheckState; onSignInStarted?: () => void }) {
  const canRunSignIn = useCanRunSignIn()
  const onSignIn: SignInHandler | undefined = canRunSignIn
    ? (agent) => { if (startAgentSignIn({ kind: agent.kind, instanceId: null })) onSignInStarted?.() }
    : undefined
  return (
    <div className="flex flex-col gap-2" aria-busy={check.checking}>
      {check.agents
        ? <AgentCheckList agents={check.agents} onSignIn={onSignIn} />
        : <Skeleton className="h-40 w-full rounded-lg" />}
      {check.error && (
        <p className="text-xs text-destructive" role="alert">
          Cogpit couldn't check your agents. {check.error}
        </p>
      )}
    </div>
  )
}

export function CheckAgainButton({ check }: { check: AgentCheckState }) {
  return (
    <Button type="button" variant="outline" onClick={check.recheck} disabled={check.checking}>
      {check.checking ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
      Check again
    </Button>
  )
}
