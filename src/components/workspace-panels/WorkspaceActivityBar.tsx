import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  RegisteredWorkspacePanel,
  WorkspacePanelContext,
} from "@/plugin-api"

interface WorkspaceActivityBarProps {
  panels: readonly RegisteredWorkspacePanel[]
  context: WorkspacePanelContext
  activePanelId: string | null
  onTogglePanel: (panelId: string) => void
}

export function availableWorkspacePanels(
  panels: readonly RegisteredWorkspacePanel[],
  context: WorkspacePanelContext,
): RegisteredWorkspacePanel[] {
  return panels.filter((panel) => panel.when?.(context) ?? true)
}

export function WorkspaceActivityBar({
  panels,
  context,
  activePanelId,
  onTogglePanel,
}: WorkspaceActivityBarProps) {
  const available = availableWorkspacePanels(panels, context)
  if (available.length === 0) return null

  return (
    <aside
      aria-label="Workspace panels"
      className="electron-no-drag flex w-11 shrink-0 flex-col items-center gap-1 border-l bg-sidebar py-2 text-sidebar-foreground"
    >
      {available.map((panel) => {
        const active = panel.id === activePanelId
        const badge = panel.badge?.(context)
        const Indicator = panel.indicator
        const Icon = panel.icon
        return (
          <Tooltip key={panel.id}>
            <TooltipTrigger
              render={(
                <Button
                  type="button"
                  variant={active ? "secondary" : "ghost"}
                  size="icon-sm"
                  aria-label={panel.title}
                  aria-pressed={active}
                  onClick={() => onTogglePanel(panel.id)}
                  className="relative rounded-md"
                />
              )}
            >
              <Icon data-icon="inline-start" />
              {Indicator ? (
                <Indicator context={context} active={active} />
              ) : badge !== null && badge !== undefined && (
                <Badge className="absolute -right-1 -top-1 min-w-4 px-1 text-[9px]" variant="secondary">
                  {badge}
                </Badge>
              )}
            </TooltipTrigger>
            <TooltipContent side="left">{panel.title}</TooltipContent>
          </Tooltip>
        )
      })}
    </aside>
  )
}

interface WorkspacePanelHostProps {
  panels: readonly RegisteredWorkspacePanel[]
  context: WorkspacePanelContext
  activePanelId: string
  onClosePanel: () => void
  onOpenPanel: (panelId: string) => void
}

export function WorkspacePanelHost({
  panels,
  context,
  activePanelId,
  onClosePanel,
  onOpenPanel,
}: WorkspacePanelHostProps) {
  const [visited, setVisited] = useState(() => new Set([activePanelId]))

  useEffect(() => {
    setVisited((current) => {
      if (current.has(activePanelId)) return current
      const next = new Set(current)
      next.add(activePanelId)
      return next
    })
  }, [activePanelId])

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-background">
      {panels.map((panel) => {
        const active = panel.id === activePanelId
        if (!active && (!panel.keepAlive || !visited.has(panel.id))) return null
        const Panel = panel.component
        return (
          <div
            key={panel.id}
            className={cn("absolute inset-0 min-h-0", !active && "hidden")}
            aria-hidden={!active}
          >
            <Panel
              context={context}
              active={active}
              closePanel={onClosePanel}
              openPanel={onOpenPanel}
            />
          </div>
        )
      })}
    </div>
  )
}
