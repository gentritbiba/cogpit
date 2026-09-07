import { useId } from "react"
import { Plug, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { PickerCheckRow, PickerChip, PickerPanel, pickerRowClass, PickerSectionLabel, pickerSideFor } from "./PickerShell"
import type { McpServer } from "./types"

interface McpPickerProps {
  servers: McpServer[]
  selected: string[]
  onToggle: (name: string) => void
  onRefresh: () => void
  loading: boolean
  onAuth: (name: string) => void
  isNewSession: boolean
}

export function McpPicker({
  servers,
  selected,
  onToggle,
  onRefresh,
  loading,
  onAuth,
  isNewSession,
}: McpPickerProps) {
  const connectedCount = servers.filter((server) => server.status === "connected").length
  const selectedNames = new Set(selected)
  const labelId = useId()
  const discovering = loading && servers.length === 0
  const chipLabel = discovering ? "MCPs" : `MCPs ${selected.length}/${connectedCount}`

  return (
    <Popover modal={false}>
      <PopoverTrigger render={<PickerChip aria-label={chipLabel} />}>
        <Plug data-icon="inline-start" />
        <span className="truncate">{chipLabel}</span>
        {discovering && <RefreshCw className="size-3 animate-spin" aria-hidden />}
      </PopoverTrigger>
      <PickerPanel side={pickerSideFor(isNewSession)} aria-label="MCP servers" className="w-72">
        <div className="flex min-h-0 flex-col p-1.5">
          <div className="flex shrink-0 items-center justify-between pr-0.5">
            <PickerSectionLabel id={labelId}>MCP servers</PickerSectionLabel>
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
          <div role="group" aria-labelledby={labelId} className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
            {servers.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {loading ? "Loading…" : "No MCP servers configured"}
              </p>
            )}
            {servers.map((server) => {
              if (server.status !== "connected") {
                return (
                  <button
                    key={server.name}
                    type="button"
                    onClick={() => onAuth(server.name)}
                    className={pickerRowClass}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
                      <span className="size-2 rounded-full bg-warning" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{server.name}</span>
                    <span className="text-xs text-warning">Needs auth</span>
                  </button>
                )
              }
              const selected = selectedNames.has(server.name)
              return (
                <PickerCheckRow
                  key={server.name}
                  icon={<span className={cn("size-2 rounded-full", selected ? "bg-success" : "bg-muted-foreground/50")} />}
                  title={server.name}
                  checked={selected}
                  onCheckedChange={() => onToggle(server.name)}
                />
              )
            })}
          </div>
        </div>
      </PickerPanel>
    </Popover>
  )
}
