import { useState } from "react"
import { Bot } from "lucide-react"
import { AgentCheckView, CheckAgainButton } from "@/components/AgentCheck/AgentCheckView"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Field, FieldDescription } from "@/components/ui/field"
import { useAgentCheck } from "@/hooks/useAgentCheck"
import { agentReadiness } from "../../../shared/contracts/agentCheck"
import { SectionTrigger } from "./SectionTrigger"

interface AgentsSectionProps {
  /** Checks only while Settings is open. */
  active: boolean
  onSignInStarted?: () => void
}

/** Each agent CLI's install and sign-in status, with the step that fixes it. */
export function AgentsSection({ active, onSignInStarted }: AgentsSectionProps) {
  const [open, setOpen] = useState(false)
  const check = useAgentCheck(active)
  const agents = check.agents
  const ready = agents?.filter((agent) => agentReadiness(agent) === "ready").length ?? 0
  const summary = agents ? `${ready} of ${agents.length} ready` : "Checking…"

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <SectionTrigger icon={Bot} title="Agents" summary={summary} open={open} />
      <CollapsibleContent>
        <Field>
          <FieldDescription>
            The coding agents installed on this computer, and whether you're signed in to each.
          </FieldDescription>
          <AgentCheckView check={check} onSignInStarted={onSignInStarted} />
          <div>
            <CheckAgainButton check={check} />
          </div>
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}
