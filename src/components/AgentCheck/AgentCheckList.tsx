import { Check, Copy, ExternalLink, LogIn } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { agentIcon } from "@/lib/agents/presentation"
import { cn } from "@/lib/utils"
import {
  agentReadiness,
  type AgentCheck,
  type AgentReadiness,
} from "../../../shared/contracts/agentCheck"

/**
 * Starts an agent's own sign-in for the person, for example in a terminal
 * Cogpit opens. Without one, each row shows the command to run instead.
 */
export type SignInHandler = (agent: AgentCheck) => void

const STATUS: Record<AgentReadiness, { label: string; className: string }> = {
  "ready": { label: "Ready", className: "bg-success/10 text-success" },
  "not-found": { label: "Not found", className: "bg-warning/10 text-warning" },
  "not-installed": { label: "Not installed", className: "border-border text-muted-foreground" },
  "signed-out": { label: "Not signed in", className: "bg-warning/10 text-warning" },
  "unknown": { label: "Unknown", className: "border-border text-muted-foreground" },
}

function CommandLine({ command, label }: { command: string; label: string }) {
  const [copied, copy] = useCopyWithFeedback()
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2.5 pr-1">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>{command}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "Copied" : label}
        onClick={() => copy(command)}
      >
        {copied
          ? <Check data-icon="inline-start" className="text-success" />
          : <Copy data-icon="inline-start" />}
      </Button>
    </div>
  )
}

function foundText(agent: AgentCheck): string | null {
  if (!agent.binary) return null
  const version = agent.version ? `Version ${agent.version}` : "Installed"
  return agent.binary.source === "bundled" ? `${version} · Included with Cogpit` : version
}

function NextStep({ agent, onSignIn }: { agent: AgentCheck; onSignIn?: SignInHandler }) {
  const readiness = agentReadiness(agent)
  if (readiness === "ready") return null

  if (agent.unlaunchableChoice) {
    const { path } = agent.unlaunchableChoice
    return (
      <p className="text-xs text-muted-foreground">
        Cogpit can't start the program chosen in Settings
        {path && <> at <code className="break-all font-mono">{path}</code></>}. Pick another under
        Settings → {agent.displayName} executable.
      </p>
    )
  }

  if (readiness === "not-installed" || !agent.signIn) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">To install it, paste this into a terminal:</p>
        <CommandLine command={agent.install.command} label={`Copy the ${agent.displayName} install command`} />
        <a
          href={agent.install.page}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Install guide
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        {readiness === "unknown"
          ? "Cogpit can't tell if you're signed in. If you're not, run this in a terminal:"
          : "To sign in, run this in a terminal:"}
      </p>
      <div className="flex items-center gap-2">
        <CommandLine command={agent.signIn.command} label={`Copy the ${agent.displayName} sign-in command`} />
        {onSignIn && (
          <Button type="button" size="sm" variant="outline" onClick={() => onSignIn(agent)}>
            <LogIn data-icon="inline-start" />
            Sign in
          </Button>
        )}
      </div>
    </div>
  )
}

interface AgentCheckListProps {
  agents: readonly AgentCheck[]
  onSignIn?: SignInHandler
  className?: string
}

/** One row per agent CLI: whether it is ready, and the one step that gets it there. */
export function AgentCheckList({ agents, onSignIn, className }: AgentCheckListProps) {
  return (
    <ul className={cn("flex flex-col divide-y divide-border rounded-lg border", className)}>
      {agents.map((agent) => {
        const Icon = agentIcon(agent.kind)
        const status = STATUS[agentReadiness(agent)]
        const found = foundText(agent)
        return (
          <li key={agent.kind} className="flex flex-col gap-2.5 p-3" data-agent={agent.kind}>
            <div className="flex items-center gap-3">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{agent.displayName}</span>
                {found && (
                  <span className="truncate text-xs text-muted-foreground" title={agent.binary?.path}>{found}</span>
                )}
              </div>
              <Badge variant="outline" className={status.className}>{status.label}</Badge>
            </div>
            <NextStep agent={agent} onSignIn={onSignIn} />
          </li>
        )
      })}
    </ul>
  )
}
