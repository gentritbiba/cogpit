import { useEffect, useState } from "react"
import { Bot } from "lucide-react"
import { cn } from "@/lib/utils"
import type { BrowserAgentActivity } from "../../../shared/session/browserActivity"

/**
 * What the agent just did to the page on screen, read off the transcript. It
 * sits over the page rather than beside it, so it costs no width, and fades
 * out once the agent stops — the transcript keeps the call forever, and a
 * caption that never left would read as if the agent were still working.
 *
 * A scrim that fades out at both ends keeps it legible over a light page
 * without drawing a seam, and it stops short of the bottom edge, which is
 * where a site puts its own footer or cookie bar.
 */

/** How long a command stays on screen after the agent stops changing it. */
const LINGER_MS = 6_000

export function AgentCaption({ activity }: { activity: BrowserAgentActivity | null }) {
  const [visible, setVisible] = useState(true)
  const stamp = activity ? `${activity.toolCallId}:${activity.done}` : null

  useEffect(() => {
    if (stamp === null) return
    setVisible(true)
    const timer = setTimeout(() => setVisible(false), LINGER_MS)
    return () => clearTimeout(timer)
  }, [stamp])

  if (!activity) return null

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-2 pb-6 pt-8",
        "bg-gradient-to-t from-transparent via-background/70 to-transparent",
        "transition-opacity duration-700 motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 rounded-full bg-background/85 px-3 py-1 text-xs shadow-xs backdrop-blur-sm">
        <Bot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="min-w-0 truncate font-mono text-[11px]">{activity.command}</code>
        <span className="shrink-0 text-muted-foreground">{activity.done ? "ran" : "running"}</span>
      </div>
    </div>
  )
}
