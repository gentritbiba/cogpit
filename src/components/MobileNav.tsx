import { MessageSquare, FolderOpen, BarChart3, Users } from "lucide-react"
import { cn } from "@/lib/utils"

export type MobileTab = "chat" | "sessions" | "stats" | "teams"

interface MobileNavProps {
  activeTab: MobileTab
  onTabChange: (tab: MobileTab) => void
  hasSession: boolean
  hasTeam: boolean
  isLive?: boolean
}

export function MobileNav({
  activeTab,
  onTabChange,
  hasSession,
  hasTeam,
  isLive,
}: MobileNavProps) {
  const tabs: { id: MobileTab; label: string; icon: typeof MessageSquare; show: boolean }[] = [
    { id: "sessions", label: "Sessions", icon: FolderOpen, show: true },
    { id: "chat", label: "Chat", icon: MessageSquare, show: true },
    { id: "stats", label: "Stats", icon: BarChart3, show: hasSession },
    { id: "teams", label: "Teams", icon: Users, show: hasTeam },
  ]

  const visibleTabs = tabs.filter((t) => t.show)

  return (
    <nav className="flex shrink-0 items-stretch border-t border-zinc-800/80 bg-zinc-900/95 glass pb-[env(safe-area-inset-bottom)]">
      {visibleTabs.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-all duration-150 min-h-[56px]",
              "active:scale-95 active:bg-zinc-800/50",
              isActive
                ? "text-blue-400"
                : "text-zinc-500"
            )}
          >
            <div className="relative">
              {isActive && (
                <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-blue-400" />
              )}
              <Icon className="size-5" />
              {tab.id === "chat" && isLive && (
                <span className="absolute -right-1 -top-1 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                </span>
              )}
            </div>
            <span className="text-[10px] font-medium">{tab.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
