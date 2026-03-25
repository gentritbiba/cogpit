import { memo, useState, useCallback, useEffect, useRef } from "react"
import { X, Plus, ExternalLink } from "lucide-react"
import type { TabSnapshot } from "@/hooks/useTabState"

interface TabBarProps {
  tabs: TabSnapshot[]
  activeTabId: string | null
  onSwitchTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onNewTab: () => void
}

/** Open a session in a new Electron window (no-op in browser). */
function openInNewWindow(tab: TabSnapshot) {
  if (!tab.dirName || !tab.fileName) return
  const sessionId = tab.fileName.replace(/\.jsonl$/, "")
  const path = `/${encodeURIComponent(tab.dirName)}/${encodeURIComponent(sessionId)}`
  if (window.electronWindow) {
    window.electronWindow.openNewWindow(path)
  } else {
    // Fallback for browser/dev mode: open in a new popup window (not a tab)
    window.open(
      `${window.location.origin}${path}`,
      "_blank",
      "width=1400,height=900,menubar=no,toolbar=no"
    )
  }
}

export const TabBar = memo(function TabBar({
  tabs,
  activeTabId,
  onSwitchTab,
  onCloseTab,
  onNewTab,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault()
    // Clamp position to keep menu within viewport (menu is ~180px wide, ~80px tall)
    const x = Math.min(e.clientX, window.innerWidth - 200)
    const y = Math.min(e.clientY, window.innerHeight - 100)
    setContextMenu({ tabId, x, y })
  }, [])

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", onKey)
    }
  }, [contextMenu])

  if (tabs.length === 0) return null

  const contextTab = contextMenu ? tabs.find(t => t.id === contextMenu.tabId) : null

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
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
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

      {/* Context menu */}
      {contextMenu && contextTab && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-lg border border-border/50 bg-elevation-2 py-1 depth-high"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-elevation-3 transition-colors"
            onClick={() => {
              openInNewWindow(contextTab)
              onCloseTab(contextTab.id)
              setContextMenu(null)
            }}
          >
            <ExternalLink className="size-3" />
            Open in New Window
          </button>
          <div className="my-1 border-t border-border/30" />
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-elevation-3 transition-colors"
            onClick={() => {
              onCloseTab(contextTab.id)
              setContextMenu(null)
            }}
          >
            <X className="size-3" />
            Close Tab
          </button>
        </div>
      )}
    </div>
  )
})
