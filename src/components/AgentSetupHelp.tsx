import { useState } from "react"
import { Check, Copy, ExternalLink, LogIn, PackageX, X, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { descriptorFor, type AgentKind } from "@/lib/agents"
import { agentAvailability, useAgentAvailability } from "@/lib/agents/availability"
import { signInCommandFor, startAgentSignIn, useCanRunSignIn } from "@/lib/agents/signIn"
import { cn } from "@/lib/utils"
import {
  agentFailureTitle,
  agentNotInstalledTitle,
  agentSignedOutTitle,
  type AgentFailure,
} from "../../shared/session/agentFailures"

/**
 * What to do when an agent cannot run: install it, or sign it in. Written for
 * someone who has never used the agent's CLI, so each card names the problem
 * in one sentence and offers one action.
 */

function CopyableCommand({ command }: { command: string }) {
  const [copied, copy] = useCopyWithFeedback()
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 py-0.5 pl-2 pr-0.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs" title={command}>{command}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => copy(command)}
        aria-label={copied ? "Command copied" : "Copy command"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

/** Install page link plus the install command, for an agent this computer does not have. */
export function AgentInstallHelp({ kind, className }: { kind: AgentKind; className?: string }) {
  const installPage = descriptorFor(kind).cli.install?.page
  // The server says which command fits the machine the agent would run on.
  const command = agentAvailability(useAgentAvailability(), kind)?.installCommand
  return (
    <div role="status" className={cn("flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-sm", className)}>
      <div className="flex items-center gap-2 font-medium">
        <PackageX className="size-4 shrink-0 text-warning" />
        {agentNotInstalledTitle(kind)}
      </div>
      <p className="text-xs text-muted-foreground">Install it, then try again.</p>
      <div className="flex flex-wrap items-center gap-2">
        {installPage && (
          <Button
            variant="outline"
            size="xs"
            render={<a href={installPage} target="_blank" rel="noopener noreferrer" />}
            nativeButton={false}
          >
            <ExternalLink data-icon="inline-start" />
            How to install
          </Button>
        )}
        {command && <CopyableCommand command={command} />}
      </div>
    </div>
  )
}

/**
 * The agent's login is missing or no longer works. Its own sign-in runs in
 * Cogpit's terminal; where there is none, the command is shown to copy.
 */
export function AgentSignInCard({ kind, detail, className = "mx-4 my-3", onDismiss }: {
  kind: AgentKind
  /** The agent's own words, when it said why. */
  detail?: string
  className?: string
  onDismiss?: () => void
}) {
  // Loads the binary path the sign-in command must use.
  useAgentAvailability()
  const canRun = useCanRunSignIn()
  const [started, setStarted] = useState(false)
  const command = signInCommandFor(kind)

  return (
    <div role="alert" data-agent-sign-in className={cn("flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm", className)}>
      <div className="flex items-center gap-2 font-medium text-destructive">
        <LogIn className="size-4 shrink-0" />
        <span className="flex-1">{agentSignedOutTitle(kind)}</span>
        {onDismiss && (
          <Button variant="ghost" size="icon-xs" onClick={onDismiss} className="text-muted-foreground" aria-label="Dismiss">
            <X />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {started
          ? "Finish signing in in the terminal below, then send your message again."
          : "Sign in once, then send your message again."}
      </p>
      {detail && <p className="text-xs text-muted-foreground/80">It said: {detail}</p>}
      {canRun ? (
        <div>
          <Button size="sm" variant={started ? "outline" : "default"} onClick={() => setStarted(startAgentSignIn(kind))}>
            <LogIn data-icon="inline-start" />
            {started ? "Open sign-in again" : "Sign in"}
          </Button>
        </div>
      ) : command && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Run this on the computer running Cogpit:</span>
          <CopyableCommand command={command} />
        </div>
      )}
    </div>
  )
}

/** A turn that ended on an error instead of a reply, in the conversation's last status slot. */
export function AgentFailureNotice({ kind, failure }: { kind: AgentKind; failure: AgentFailure }) {
  if (failure.reason === "not_signed_in") return <AgentSignInCard kind={kind} detail={failure.message} />
  if (failure.reason === "not_installed") return <AgentInstallHelp kind={kind} className="mx-4 my-3" />
  return (
    <div role="status" data-agent-failed className="flex min-w-0 items-center gap-2.5 px-4 py-3">
      <XCircle className="size-4 shrink-0 text-destructive" />
      <span className="shrink-0 text-xs font-medium text-destructive">{agentFailureTitle(kind, failure)}</span>
      <span className="truncate text-xs text-muted-foreground" title={failure.message}>{failure.message.split("\n", 1)[0]}</span>
    </div>
  )
}
