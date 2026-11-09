import { createContext, useContext, useState, type ReactNode } from "react"

interface StatusPanel {
  /** The session whose status the panel leads with; null leads with the open session. */
  target: string | null
  /** Leads the panel with `sessionId` and brings the panel up. */
  open: (sessionId: string) => void
}

const StatusPanelContext = createContext<StatusPanel | null>(null)

/**
 * Lets the session list and the status panel share whose status it leads
 * with. Opening another conversation drops the choice, whether or not the
 * panel is shown, so the lead goes back to the open conversation.
 */
export function StatusPanelProvider({ openSessionId, onReveal, children }: {
  openSessionId: string | null
  onReveal: () => void
  children: ReactNode
}) {
  const [choice, setChoice] = useState<{ sessionId: string; from: string | null } | null>(null)
  if (choice && choice.from !== openSessionId) setChoice(null)
  const open = (sessionId: string) => {
    setChoice({ sessionId, from: openSessionId })
    onReveal()
  }
  const target = choice?.from === openSessionId ? choice.sessionId : null
  return (
    <StatusPanelContext.Provider value={{ target, open }}>
      {children}
    </StatusPanelContext.Provider>
  )
}

/** The status panel, or null where the layout has none (a shared session, a preview). */
export function useStatusPanel(): StatusPanel | null {
  return useContext(StatusPanelContext)
}
