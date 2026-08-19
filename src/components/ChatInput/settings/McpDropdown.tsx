import { ChevronDown, Plug, RefreshCw } from "lucide-react"
import { useId } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { McpServer } from "./types"

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
  const connectedCount = servers.filter((server) => server.status === "connected").length
  const selectedNames = new Set(selected)
  const menuLabelId = useId()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="xs" />}>
        <Plug data-icon="inline-start" />
        <span className="truncate">
          {loading && servers.length === 0 ? "MCPs" : `MCPs ${selected.length}/${connectedCount}`}
        </span>
        {loading && servers.length === 0
          ? <RefreshCw data-icon="inline-end" className="animate-spin" />
          : <ChevronDown data-icon="inline-end" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-labelledby={menuLabelId} className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel id={menuLabelId}>MCP servers</DropdownMenuLabel>
          <DropdownMenuItem closeOnClick={false} onClick={onRefresh}>
            <RefreshCw data-icon="inline-start" className={loading ? "animate-spin" : undefined} />
            Refresh status
          </DropdownMenuItem>
          {servers.length === 0 && (
            <DropdownMenuItem disabled>
              {loading ? "Loading..." : "No MCP servers configured"}
            </DropdownMenuItem>
          )}
          {servers.map((server) => {
            if (server.status !== "connected") {
              return (
                <DropdownMenuItem
                  key={server.name}
                  onClick={() => onAuth(server.name)}
                  className="items-center"
                >
                  <span className="size-2 rounded-full bg-warning" />
                  <span className="min-w-0 flex-1 truncate">{server.name}</span>
                  <span className="text-xs text-warning">Needs auth</span>
                </DropdownMenuItem>
              )
            }

            return (
              <DropdownMenuCheckboxItem
                key={server.name}
                checked={selectedNames.has(server.name)}
                onCheckedChange={() => onToggle(server.name)}
              >
                <span className="size-2 rounded-full bg-success" />
                <span className="truncate">{server.name}</span>
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
