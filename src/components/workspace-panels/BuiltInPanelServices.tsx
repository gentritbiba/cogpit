import { createContext, useContext, type ReactNode, type RefObject } from "react"
import type { BgAgent } from "@/hooks/useBackgroundAgents"
import type { BuiltInEditorRequest } from "@/lib/fileOpener"
import type { ProjectPromptContext } from "@/plugin-api"

export interface BuiltInPanelServices {
  projectFilesRoot: string | null
  projectFilesRequest: BuiltInEditorRequest | null
  backgroundAgents: BgAgent[]
  searchInputRef: RefObject<HTMLInputElement | null>
  addProjectContext: (context: ProjectPromptContext) => void
  jumpToTurn: (turnIndex: number, toolCallId?: string) => void
  toggleServer: (id: string, outputPath: string, title: string) => void
  serversChanged: (servers: { id: string; outputPath: string; title: string }[]) => void
  loadSession: (dirName: string, fileName: string) => void
}

const Context = createContext<BuiltInPanelServices | null>(null)

export function BuiltInPanelServicesProvider({
  value,
  children,
}: {
  value: BuiltInPanelServices
  children: ReactNode
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useBuiltInPanelServices(): BuiltInPanelServices {
  const value = useContext(Context)
  if (!value) throw new Error("Built-in workspace panel services are unavailable")
  return value
}
