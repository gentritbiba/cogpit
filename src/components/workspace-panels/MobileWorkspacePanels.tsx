import type { ReactNode } from "react"
import { ArrowLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import type { RegisteredWorkspacePanel, WorkspacePanelContext } from "@/plugin-api"
import { availableWorkspacePanels, WorkspacePanelHost, type WorkspaceActivityAction } from "./WorkspaceActivityBar"

interface MobileWorkspacePanelsProps {
  panels: readonly RegisteredWorkspacePanel[]
  context: WorkspacePanelContext
  activePanelId: string | null
  active: boolean
  onSelectPanel: (id: string) => void
  onClosePanel: () => void
  actions?: readonly WorkspaceActivityAction[]
  actionContent?: ReactNode
}

export function MobileWorkspacePanels({
  panels, context, activePanelId, active, onSelectPanel, onClosePanel,
  actions = [], actionContent,
}: MobileWorkspacePanelsProps) {
  const available = availableWorkspacePanels(panels, context)
  const selected = available.find((panel) => panel.id === activePanelId)
  const action = actions.find((item) => item.active)
  const title = action?.title ?? selected?.title
  const project = context.projectPath?.split(/[/\\]/).filter(Boolean).at(-1)

  return (
    <section aria-label="Workspace" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-3">
        {title ? (
          <>
            <Button variant="ghost" size="icon-lg" onClick={onClosePanel} aria-label="All workspace tools">
              <ArrowLeft data-icon="inline-start" />
            </Button>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
            <Button variant="outline" onClick={onClosePanel}>Switch</Button>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
            <h1 className="text-base font-medium">Workspace</h1>
            {project && <span className="truncate text-xs text-muted-foreground" title={context.projectPath ?? undefined}>{project}</span>}
          </div>
        )}
      </header>

      {!title && (
        <div className="mobile-scroll min-h-0 flex-1 overflow-y-auto p-3">
          <nav aria-label="Workspace tools" className="grid grid-cols-2 gap-2">
            {available.map((panel) => {
              const Icon = panel.icon
              const Indicator = panel.indicator
              const badge = panel.badge?.(context)
              return (
                <Button key={panel.id} variant="outline" aria-label={panel.title} className="h-auto min-h-24 min-w-0 flex-col items-start justify-between gap-3 whitespace-normal p-3 text-left" onClick={() => onSelectPanel(panel.id)}>
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="relative"><Icon data-icon="inline-start" />{Indicator && <Indicator context={context} active={false} />}</span>
                    {badge !== null && badge !== undefined && <Badge variant="secondary">{badge}</Badge>}
                  </span>
                  <span className="flex w-full items-center justify-between gap-2"><span>{panel.title}</span><ChevronRight data-icon="inline-end" /></span>
                </Button>
              )
            })}
            {actions.map(({ id, title: label, icon: Icon, onSelect }) => (
              <Button key={id} variant="outline" className="h-auto min-h-24 min-w-0 flex-col items-start justify-between gap-3 whitespace-normal p-3 text-left" onClick={onSelect}>
                <Icon data-icon="inline-start" />
                <span className="flex w-full items-center justify-between gap-2"><span>{label}</span><ChevronRight data-icon="inline-end" /></span>
              </Button>
            ))}
          </nav>
        </div>
      )}

      <div className={title ? "relative min-h-0 flex-1" : "hidden"}>
        <ErrorBoundary key={action?.id ?? selected?.id ?? "workspace"} fallbackMessage="Couldn't open this workspace tool">
          {action && actionContent}
        </ErrorBoundary>
        <div className={action ? "hidden" : "h-full min-h-0"}>
          <WorkspacePanelHost
            panels={available}
            context={context}
            activePanelId={selected?.id ?? ""}
            active={active && !action}
            onClosePanel={onClosePanel}
          />
        </div>
      </div>
    </section>
  )
}
