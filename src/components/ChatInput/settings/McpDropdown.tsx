import { createPortal } from "react-dom"
import { Check, ChevronDown, Plug, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import type { McpServer } from "./types"
import { MENU_OFFSET_STYLE, useDropdownState } from "./useDropdownState"

interface McpDropdownProps {
  servers: McpServer[]
  selected: string[]
  onToggle: (name: string) => void
  onRefresh: () => void
  loading: boolean
  onAuth: (name: string) => void
}

export function McpDropdown({
  servers,
  selected,
  onToggle,
  onRefresh,
  loading,
  onAuth,
}: McpDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()
  const connectedCount = servers.filter((server) => server.status === "connected").length
  const selectedCount = selected.length
  const selectedNames = new Set(selected)

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-white/5",
        )}
      >
        <Plug className="size-3" />
        <span className="truncate">
          {loading && servers.length === 0 ? "MCPs" : `MCPs ${selectedCount}/${connectedCount}`}
        </span>
        {loading && servers.length === 0
          ? <RefreshCw className="size-3 opacity-50 animate-spin" />
          : <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />}
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="MCP servers"
          className="fixed z-[9999] min-w-[180px] rounded-lg border border-border/50 bg-elevation-3 py-1 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              MCP Servers
            </span>
            <button
              type="button"
              aria-label="Refresh MCP server status"
              onClick={(event) => { event.stopPropagation(); onRefresh() }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh status"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            </button>
          </div>

          {servers.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              {loading ? "Loading..." : "No MCP servers configured"}
            </div>
          )}

          {servers.map((server) => {
            const isConnected = server.status === "connected"
            const isSelected = selectedNames.has(server.name)

            if (!isConnected) {
              return (
                <div
                  key={server.name}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground/50"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { onAuth(server.name); closeAndFocus() }}
                    className="flex items-center gap-2 flex-1 min-w-0 hover:bg-white/5 transition-colors rounded-sm -mx-1 px-1 py-0.5"
                  >
                    <span className="size-2 rounded-full bg-amber-500/60 shrink-0" />
                    <span className="truncate">{server.name}</span>
                    <span className="ml-auto text-[9px] text-amber-500/70 shrink-0">Needs auth</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Refresh ${server.name} status`}
                    onClick={(event) => { event.stopPropagation(); onRefresh() }}
                    className="text-muted-foreground/50 hover:text-foreground transition-colors shrink-0 p-0.5 rounded-sm hover:bg-white/5"
                    title="Refresh status"
                  >
                    <RefreshCw className={cn("size-3", loading && "animate-spin")} />
                  </button>
                </div>
              )
            }

            return (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isSelected}
                key={server.name}
                onClick={() => onToggle(server.name)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-[11px] transition-colors",
                  isSelected
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  "hover:bg-white/5",
                )}
              >
                <span className={cn(
                  "size-2 rounded-full shrink-0",
                  isSelected ? "bg-emerald-500" : "bg-zinc-600",
                )} />
                <span className="truncate">{server.name}</span>
                {isSelected && <Check className="size-3 ml-auto text-emerald-500" />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
