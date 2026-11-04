import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/Spinner"
import type { AgentCheckState } from "@/hooks/useAgentCheck"
import { AgentCheckList, type SignInHandler } from "./AgentCheckList"

/** The agent rows, a placeholder while the first check runs, and its error. */
export function AgentCheckView({ check, onSignIn }: { check: AgentCheckState; onSignIn?: SignInHandler }) {
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
