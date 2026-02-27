import { memo } from "react"
import type { LucideIcon } from "lucide-react"
import { MessageSquare, FolderOpen, BarChart3, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { LiveIndicator } from "@/components/header-shared"

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
  hasSession: boolean
  hasTeam: boolean
  isLive?: boolean
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
  hasSession,
  hasTeam,
  isLive,
}: MobileNavProps) {
  const visibleTabs = TAB_DEFINITIONS.filter((t) => {
    if (t.requiresSession && !hasSession) return false
    if (t.requiresTeam && !hasTeam) return false
    return true
  })

  return (
    <nav className="flex shrink-0 items-stretch border-t border-border/50 bg-elevation-1 depth-mid pb-[env(safe-area-inset-bottom)]" role="tablist" aria-label="Navigation">
      {visibleTabs.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-label={tab.label}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-150 min-h-[56px]",
              "active:scale-95 active:bg-elevation-2",
              isActive ? "text-blue-400" : "text-muted-foreground",
            )}
          >
            <div className="relative">
              {isActive && (
                <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-blue-400" />
              )}
              <Icon className="size-5" />
              {tab.id === "chat" && isLive && (
                <LiveIndicator className="absolute -right-1 -top-1" />
              )}
            </div>
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
})
