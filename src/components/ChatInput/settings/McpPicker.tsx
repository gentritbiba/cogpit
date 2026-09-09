import { useId, useState } from "react"
import { LogIn, Plug, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { serverMonogram, splitServerName } from "./mcpNames"
import { PickerChip, PickerPanel, PickerSectionLabel, pickerSideFor } from "./PickerShell"
import type { McpServer } from "../../../../shared/contracts/projectTools"

/** Past this many servers a filter box is worth its row. */
const FILTER_THRESHOLD = 8

interface McpPickerProps {
  servers: McpServer[]
  selected: string[]
  onToggle: (name: string) => void
  onSetSelection?: (names: string[]) => void
  onRefresh: () => void
  loading: boolean
  onAuth: (name: string) => void
  isNewSession: boolean
}

export function McpPicker({
  servers,
  selected,
  onToggle,
  onSetSelection,
  onRefresh,
  loading,
  onAuth,
  isNewSession,
}: McpPickerProps) {
  const [filter, setFilter] = useState("")
  const labelId = useId()

  const connected = servers.filter((server) => server.status === "connected")
  const unavailable = servers.filter((server) => server.status !== "connected")
  const selectedNames = new Set(selected)
  const onCount = connected.filter((server) => selectedNames.has(server.name)).length
  const discovering = loading && servers.length === 0
  const chipLabel = discovering ? "MCPs" : `MCPs ${onCount}/${connected.length}`

  const query = filter.trim().toLowerCase()
  const matches = (server: McpServer) => !query || server.name.toLowerCase().includes(query)
  const visibleConnected = connected.filter(matches)
  const visibleUnavailable = unavailable.filter(matches)

  return (
    <Popover modal={false} onOpenChange={(open) => { if (!open) setFilter("") }}>
      <PopoverTrigger render={<PickerChip aria-label={chipLabel} />}>
        <Plug data-icon="inline-start" />
        <span className="truncate">{chipLabel}</span>
        {discovering && <RefreshCw className="size-3 animate-spin" aria-hidden />}
      </PopoverTrigger>
      <PickerPanel side={pickerSideFor(isNewSession)} aria-label="MCP servers" className="w-[23rem]">
        <div className="flex shrink-0 items-center justify-between gap-2 px-1.5 pt-1.5">
          <PickerSectionLabel id={labelId} className="pt-1">
            MCP servers
            {connected.length > 0 && (
              <span aria-hidden className="ml-1.5 font-normal normal-case tracking-normal">{onCount} on</span>
            )}
          </PickerSectionLabel>
          <div className="flex items-center gap-0.5">
            {onSetSelection && connected.length > 1 && (
              <>
                <HeaderAction
                  label="Turn every server on"
                  disabled={onCount === connected.length}
                  onClick={() => onSetSelection(connected.map((server) => server.name))}
                >
                  All
                </HeaderAction>
                <HeaderAction
                  label="Turn every server off"
                  disabled={onCount === 0}
                  onClick={() => onSetSelection([])}
                >
                  None
                </HeaderAction>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onRefresh}
              aria-label="Refresh status"
              title="Refresh status"
              className="text-muted-foreground"
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {servers.length > FILTER_THRESHOLD && (
          <div className="shrink-0 px-1.5 pt-1">
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter servers…"
              aria-label="Filter servers"
              className="h-7 w-full rounded-md bg-muted/60 px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-search-cancel-button]:hidden"
            />
          </div>
        )}

        <div role="group" aria-labelledby={labelId} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
          {servers.length === 0 && (
            <p className="px-0.5 py-1 text-xs text-muted-foreground">
              {loading ? "Loading…" : "No MCP servers configured"}
            </p>
          )}
          {servers.length > 0 && visibleConnected.length === 0 && visibleUnavailable.length === 0 && (
            <p className="px-0.5 py-1 text-xs text-muted-foreground">No servers match.</p>
          )}

          {visibleConnected.length > 0 && (
            <div className="grid grid-cols-2 gap-1">
              {visibleConnected.map((server) => (
                <ServerTile
                  key={server.name}
                  server={server}
                  on={selectedNames.has(server.name)}
                  onClick={() => onToggle(server.name)}
                />
              ))}
            </div>
          )}

          {visibleUnavailable.length > 0 && (
            <>
              <PickerSectionLabel className="px-0.5 pt-2 text-warning/80">Needs sign-in</PickerSectionLabel>
              <div className="grid grid-cols-2 gap-1">
                {visibleUnavailable.map((server) => (
                  <ServerTile key={server.name} server={server} onClick={() => onAuth(server.name)} />
                ))}
              </div>
            </>
          )}
        </div>
      </PickerPanel>
    </Popover>
  )
}

interface HeaderActionProps {
  label: string
  disabled: boolean
  onClick: () => void
  children: string
}

function HeaderAction({ label, disabled, onClick, children }: HeaderActionProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="h-6 px-1.5 text-[11px] text-muted-foreground"
    >
      {children}
    </Button>
  )
}

interface ServerTileProps {
  server: McpServer
  /** Undefined for a server that still needs sign-in, which the tile connects instead of toggling. */
  on?: boolean
  onClick: () => void
}

/**
 * One server as a switchboard tile: a monogram badge that lights up with the
 * server, its short name, and the namespace it came from underneath.
 */
function ServerTile({ server, on, onClick }: ServerTileProps) {
  const { short, namespace } = splitServerName(server.name)
  const needsAuth = on === undefined
  return (
    <button
      type="button"
      role={needsAuth ? undefined : "checkbox"}
      aria-checked={needsAuth ? undefined : on}
      aria-label={needsAuth ? `${server.name}, needs sign-in` : server.name}
      title={needsAuth ? `${server.name} · Sign in to connect` : server.name}
      onClick={onClick}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none ring-1 ring-inset transition-[background-color,box-shadow,color] duration-100 focus-visible:ring-2 focus-visible:ring-ring/40",
        needsAuth && "bg-warning/5 ring-warning/25 hover:bg-warning/10",
        on === true && "bg-accent text-accent-foreground ring-foreground/10",
        on === false && "text-muted-foreground ring-transparent hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tracking-wide transition-colors duration-100",
          needsAuth && "bg-warning/15 text-warning",
          on === true && "bg-primary text-primary-foreground",
          on === false && "bg-muted text-muted-foreground",
        )}
      >
        {serverMonogram(server.name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-4">{short}</span>
        {namespace && <span className="truncate text-[10px] leading-3 text-muted-foreground">{namespace}</span>}
      </span>
      {needsAuth && <LogIn className="size-3.5 shrink-0 text-warning" aria-hidden />}
    </button>
  )
}
