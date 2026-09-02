import type { ReactNode } from "react"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import type {
  RegisteredWorkspacePanel,
  WorkspacePanelContext,
} from "@/plugin-api"
import {
  BuiltInPanelServicesProvider,
  type BuiltInPanelServices,
} from "./BuiltInPanelServices"
import { WorkspaceActivityBar, WorkspacePanelHost } from "./WorkspaceActivityBar"

interface DesktopWorkspacePanelsProps {
  children: ReactNode
  panels: readonly RegisteredWorkspacePanel[]
  context: WorkspacePanelContext
  activePanel: RegisteredWorkspacePanel | null
  services: BuiltInPanelServices
  onClosePanel: () => void
  onOpenPanel: (panelId: string) => void
  onTogglePanel: (panelId: string) => void
}

function mainPanelDefaultSize(panelSize?: string): string {
  const match = panelSize?.match(/^(\d+(?:\.\d+)?)%$/)
  if (!match) return "64%"
  const percentage = Number(match[1])
  return percentage > 0 && percentage < 100 ? `${100 - percentage}%` : "64%"
}

export function DesktopWorkspacePanels({
  children,
  panels,
  context,
  activePanel,
  services,
  onClosePanel,
  onOpenPanel,
  onTogglePanel,
}: DesktopWorkspacePanelsProps) {
  return (
    <>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 min-w-0 w-auto flex-1">
        <ResizablePanel
          defaultSize={activePanel
            ? mainPanelDefaultSize(activePanel.defaultSize)
            : "100%"}
          minSize="320px"
        >
          {children}
        </ResizablePanel>

        {activePanel && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={activePanel.defaultSize ?? "36%"}
              minSize={activePanel.minSize ?? "300px"}
              maxSize={activePanel.maxSize ?? "70%"}
            >
              <BuiltInPanelServicesProvider value={services}>
                <WorkspacePanelHost
                  panels={panels}
                  context={context}
                  activePanelId={activePanel.id}
                  onClosePanel={onClosePanel}
                  onOpenPanel={onOpenPanel}
                />
              </BuiltInPanelServicesProvider>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>

      <WorkspaceActivityBar
        panels={panels}
        context={context}
        activePanelId={activePanel?.id ?? null}
        onTogglePanel={onTogglePanel}
      />
    </>
  )
}
