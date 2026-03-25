import { createContext, useContext, type ReactNode } from "react"
import type { TabState, TabAction, TabSnapshot } from "@/hooks/useTabState"

export interface TabContextValue {
  tabs: TabSnapshot[]
  activeTabId: string | null
  dispatch: React.Dispatch<TabAction>
  /** Switch to a tab, snapshotting the current one first. */
  switchTab: (tabId: string) => void
  /** Open a session in a new tab (or switch if already open). */
  openInNewTab: (dirName: string, fileName: string, label: string) => void
  /** Close a tab with optional confirmation for running sessions. */
  closeTab: (tabId: string) => void
}

const TabContext = createContext<TabContextValue | null>(null)

export function TabProvider({ value, children }: { value: TabContextValue; children: ReactNode }) {
  return <TabContext.Provider value={value}>{children}</TabContext.Provider>
}

export function useTabContext(): TabContextValue | null {
  return useContext(TabContext)
}
