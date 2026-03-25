import { memo } from "react"
import { X, Plus } from "lucide-react"
import type { TabSnapshot } from "@/hooks/useTabState"

interface TabBarProps {
  tabs: TabSnapshot[]
  activeTabId: string | null
  onSwitchTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onNewTab: () => void
}

export const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onSwitchTab,
  onCloseTab,
  onNewTab,
}: TabBarProps) {
  if (tabs.length === 0) return null

  return (
    <div className="flex items-center h-8 bg-elevation-0 border-b border-border/50 overflow-x-auto shrink-0">
      <div className="flex items-center min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={`
                group relative flex items-center gap-1.5 h-8 px-3 min-w-0 max-w-[180px] cursor-pointer
                text-xs select-none border-b-2 transition-colors
                ${isActive
                  ? "border-accent text-foreground bg-elevation-1"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-elevation-1/50"
                }
              `}
              onClick={() => onSwitchTab(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  onCloseTab(tab.id)
                }
              }}
            >
              {tab.hasUnreadActivity && (
                <span
                  data-activity-dot
                  className="absolute left-1 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-cyan-400"
                />
              )}
              <span className="truncate">{tab.label}</span>
              <button
                aria-label="Close tab"
                className="shrink-0 size-4 flex items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(tab.id)
                }}
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        aria-label="New tab"
        className="shrink-0 flex items-center justify-center size-8 text-muted-foreground hover:text-foreground hover:bg-elevation-1/50 transition-colors"
        onClick={onNewTab}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
})
