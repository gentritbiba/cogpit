import { memo } from "react"
import type { LucideIcon } from "lucide-react"
import { MessageSquare, FolderOpen, PanelsTopLeft } from "lucide-react"
import { cn } from "@/lib/utils"
import { LiveIndicator } from "@/components/header-shared"
import { useSessionContext } from "@/contexts/SessionContext"
import { hapticLight } from "@/lib/haptics"

export type MobileTab = "chat" | "sessions" | "workspace"

interface TabDefinition {
  id: MobileTab
  label: string
  icon: LucideIcon
}

interface MobileNavProps {
  activeTab: MobileTab
  onTabChange: (tab: MobileTab) => void
}

const TAB_DEFINITIONS: TabDefinition[] = [
  { id: "sessions", label: "Sessions", icon: FolderOpen },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "workspace", label: "Workspace", icon: PanelsTopLeft },
]

export const MobileNav = memo(function MobileNav({
  activeTab,
  onTabChange,
}: MobileNavProps) {
  const { isLive } = useSessionContext()

  return (
    <nav
      className="flex shrink-0 items-stretch border-t bg-background pb-[env(safe-area-inset-bottom)]"
      aria-label="Navigation"
    >
      {TAB_DEFINITIONS.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            aria-label={tab.label}
            title={tab.label}
            onClick={() => { hapticLight(); onTabChange(tab.id) }}
            className={cn(
              "flex min-h-14 flex-1 items-center justify-center outline-none transition-[color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <div className={cn(
              "relative flex size-9 items-center justify-center rounded-md transition-[background-color,transform,scale] duration-150 ease-out motion-reduce:transition-none",
              isActive ? "scale-100 bg-accent" : "scale-95",
            )}>
              <Icon
                className={cn(
                  "size-[18px] transition-transform duration-150 ease-out motion-reduce:transition-none",
                  isActive && "scale-110",
                )}
                aria-hidden="true"
              />
              {tab.id === "chat" && isLive && (
                <LiveIndicator className="absolute right-0.5 top-0.5 size-1.5 ring-2 ring-background" />
              )}
            </div>
          </button>
        )
      })}
    </nav>
  )
})
