import { memo } from "react"
import type { LucideIcon } from "lucide-react"
import { MessageSquare, FolderOpen, BarChart3, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { LiveIndicator } from "@/components/header-shared"
import { useSessionContext } from "@/contexts/SessionContext"
import { hapticLight } from "@/lib/haptics"

export type MobileTab = "chat" | "sessions" | "stats" | "teams"

interface TabDefinition {
  id: MobileTab
  label: string
  icon: LucideIcon
  requiresSession?: boolean
  requiresTeam?: boolean
}

interface MobileNavProps {
  activeTab: MobileTab
  onTabChange: (tab: MobileTab) => void
  hasTeam: boolean
}

const TAB_DEFINITIONS: TabDefinition[] = [
  { id: "sessions", label: "Sessions", icon: FolderOpen },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "stats", label: "Stats", icon: BarChart3, requiresSession: true },
  { id: "teams", label: "Teams", icon: Users, requiresTeam: true },
]

export const MobileNav = memo(function MobileNav({
  activeTab,
  onTabChange,
  hasTeam,
}: MobileNavProps) {
  const { session, isLive } = useSessionContext()
  const hasSession = session !== null
  const visibleTabs = TAB_DEFINITIONS.filter((t) => {
    if (t.requiresSession && !hasSession) return false
    if (t.requiresTeam && !hasTeam) return false
    return true
  })

  return (
    <nav
      className="flex shrink-0 items-stretch border-t border-border/40 bg-elevation-1/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      aria-label="Navigation"
    >
      {visibleTabs.map((tab) => {
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
              "flex min-h-11 flex-1 items-center justify-center transition-colors duration-150",
              "active:bg-elevation-2",
              isActive ? "text-primary" : "text-muted-foreground",
            )}
          >
            <div className={cn(
              "relative flex size-8 items-center justify-center rounded-xl transition-colors",
              isActive && "bg-primary/10",
            )}>
              <Icon className="size-[18px]" />
              {tab.id === "chat" && isLive && (
                <LiveIndicator className="absolute -right-1 -top-1" />
              )}
            </div>
          </button>
        )
      })}
    </nav>
  )
})
