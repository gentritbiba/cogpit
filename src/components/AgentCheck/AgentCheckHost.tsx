import { lazy, Suspense, useEffect, useState } from "react"

const AgentCheckDialog = lazy(() => import("./AgentCheckDialog").then((module) => ({ default: module.AgentCheckDialog })))

const AGENT_CHECK_EVENT = "cogpit-check-agents"

/** Open the agent check from anywhere; the app shell hosts it. */
export function openAgentCheck(): void {
  window.dispatchEvent(new Event(AGENT_CHECK_EVENT))
}

/**
 * The agent check dialog, opened by {@link openAgentCheck}: the command
 * palette and the home's getting-started card ask for it without holding its
 * state. Mounted once per app shell; the dialog loads on the first request.
 */
export function AgentCheckHost() {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(AGENT_CHECK_EVENT, show)
    return () => window.removeEventListener(AGENT_CHECK_EVENT, show)
  }, [])

  if (open === null) return null
  return (
    <Suspense fallback={null}>
      <AgentCheckDialog open={open} onOpenChange={setOpen} />
    </Suspense>
  )
}
