import { useEffect, useState, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
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
  actions?: readonly WorkspaceActivityAction[]
}

export interface WorkspaceActivityAction {
  id: string
  title: string
  icon: LucideIcon
  active: boolean
  onSelect: () => void
}

function ActivityBarButton({
  title,
  icon: Icon,
  active,
  onClick,
  children,
}: {
  title: string
  icon: LucideIcon
  active: boolean
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={title}
            aria-pressed={active}
            onClick={onClick}
            className={cn(
              "relative rounded-md",
              active && "bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90 hover:text-sidebar-primary-foreground",
            )}
          />
        )}
      >
        <Icon data-icon="inline-start" />
        {children}
      </TooltipTrigger>
      <TooltipContent side="left">{title}</TooltipContent>
    </Tooltip>
  )
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
  actions = [],
}: WorkspaceActivityBarProps) {
  const available = availableWorkspacePanels(panels, context)
  if (available.length === 0 && actions.length === 0) return null

  return (
    <aside
      aria-label="Workspace panels"
      className="electron-no-drag flex w-11 shrink-0 flex-col items-center gap-1 border-l bg-sidebar py-2 text-sidebar-foreground"
    >
      {actions.map((action) => (
        <ActivityBarButton
          key={action.id}
          title={action.title}
          icon={action.icon}
          active={action.active}
          onClick={action.onSelect}
        />
      ))}

      {actions.length > 0 && available.length > 0 && (
        <div aria-hidden className="my-1 h-px w-6 bg-sidebar-border" />
      )}

      {available.map((panel) => {
        const active = panel.id === activePanelId
        const badge = panel.badge?.(context)
        const Indicator = panel.indicator
        return (
          <ActivityBarButton
            key={panel.id}
            title={panel.title}
            icon={panel.icon}
            active={active}
            onClick={() => onTogglePanel(panel.id)}
          >
            {Indicator ? (
              <Indicator context={context} active={active} />
            ) : badge !== null && badge !== undefined && (
              <Badge className="absolute -right-1 -top-1 min-w-4 px-1 text-[9px]" variant="secondary">
                {badge}
              </Badge>
            )}
          </ActivityBarButton>
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
