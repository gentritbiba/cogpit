import { createContext, useContext, useState, type ReactNode } from "react"
import type { ViewReference } from "../../../shared/views/stored"

interface ViewPanel {
  /** The version the panel shows; null shows the list of views. */
  target: ViewReference | null
  /** Whether the panel is on screen now. */
  shown: boolean
  /** Shows `target` in the panel and brings the panel up. */
  open: (target: ViewReference) => void
  /** Changes what the panel shows without bringing it up. */
  select: (target: ViewReference | null) => void
}

const ViewPanelContext = createContext<ViewPanel | null>(null)

/** Lets the sidebar, a reply's view card and the panel share which view the panel shows. */
export function ViewPanelProvider({ shown, onReveal, children }: { shown: boolean; onReveal: () => void; children: ReactNode }) {
  const [target, setTarget] = useState<ViewReference | null>(null)
  const open = (next: ViewReference) => {
    setTarget(next)
    onReveal()
  }
  return (
    <ViewPanelContext.Provider value={{ target, shown, open, select: setTarget }}>
      {children}
    </ViewPanelContext.Provider>
  )
}

/** The view panel, or null where the layout has none (a shared session, a preview). */
export function useViewPanel(): ViewPanel | null {
  return useContext(ViewPanelContext)
}
