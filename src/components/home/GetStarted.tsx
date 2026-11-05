import type { ReactNode } from "react"
import { Circle, CircleCheck, ExternalLink, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FIRST_SESSION_GUIDE_URL } from "../../../shared/helpLinks"
import type { AgentSummary } from "./firstRun"

interface GetStartedProps {
  agent: AgentSummary
  /** The folder chosen in the composer below, if any. */
  projectName: string | null
  /** Opens the folder browser; shown until a folder is chosen. */
  folderButton: ReactNode
  onCheckAgents: () => void
  onDismiss: () => void
}

/**
 * A new install's first screen: what Cogpit does, and the three things a
 * first task needs, each ticked from the real state as it happens.
 */
export function GetStarted({ agent, projectName, folderButton, onCheckAgents, onDismiss }: GetStartedProps) {
  return (
    <section aria-labelledby="get-started-title" className="relative flex flex-col gap-3 rounded-xl border bg-card/40 p-4 pr-10">
      <div className="flex flex-col gap-1">
        <h2 id="get-started-title" className="text-sm font-medium">Get started</h2>
        <p className="text-xs text-muted-foreground">
          Cogpit lets an AI coding agent work on a project folder on your computer, and shows you everything it does.
        </p>
      </div>
      <ol className="flex flex-col gap-2.5">
        <Step done={agent.ready} title="Connect a coding agent" detail={agent.text}>
          <Button variant="link" size="xs" className="h-auto px-0" onClick={onCheckAgents}>Check agent setup</Button>
        </Step>
        <Step
          done={projectName !== null}
          title="Choose your project folder"
          detail={projectName ?? "The agent works only inside the folder you choose."}
        >
          {projectName === null && folderButton}
        </Step>
        <Step done={false} title="Send your first task" detail="Describe it below, or start with an example." />
      </ol>
      <a
        href={FIRST_SESSION_GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Read the first-session guide
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss getting started"
        title="Dismiss"
        onClick={onDismiss}
        className="absolute right-2 top-2 text-muted-foreground"
      >
        <X data-icon="icon" />
      </Button>
    </section>
  )
}

function Step({ done, title, detail, children }: { done: boolean; title: string; detail: string; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      {done
        ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />
        : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" aria-label="To do" />}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-col">
          <span className={cn("text-[13px] font-medium", done && "text-muted-foreground")}>{title}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </div>
        {children}
      </div>
    </li>
  )
}
