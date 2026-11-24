import { useState } from "react"
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Bug,
  ChartColumn,
  Globe,
  Keyboard,
  Puzzle,
  Search,
  Settings,
  Skull,
  SlidersHorizontal,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PowerMonitor } from "@/components/PowerMonitor"
import { UsageCostDialog } from "@/components/UsageCostDialog"
import { useAppContext } from "@/contexts/AppContext"
import { useCapability } from "@/hooks/useCapability"
import { useCogpitUpdate } from "@/hooks/useCogpitUpdate"
import { useCan } from "@/hooks/useCapability"
import { shortcutLabel } from "@/lib/keybindings"
import { copyToClipboard } from "@/lib/utils"
import { DOCUMENTATION_URL, REPORT_ISSUE_URL } from "../../shared/helpLinks"

interface AppMenuProps {
  killing: boolean
  onKillAll: () => void
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
  onOpenKeyboardShortcuts: () => void
  onOpenPlugins: () => void
  onOpenAgentFiles: () => void
  /** Opened from outside the menu, by the leak indicator. */
  monitorOpen: boolean
  onMonitorOpenChange: (open: boolean) => void
}

/** Everything about the app rather than the open session, behind one button. */
export function AppMenu({
  killing,
  onKillAll,
  onOpenSettings,
  onOpenCommandPalette,
  onOpenKeyboardShortcuts,
  onOpenPlugins,
  onOpenAgentFiles,
  monitorOpen,
  onMonitorOpenChange,
}: AppMenuProps) {
  const can = useCan()
  const { config: { networkUrl } } = useAppContext()
  const canViewUsage = useCapability("viewUsage")
  const { update } = useCogpitUpdate()
  const [usageOpen, setUsageOpen] = useState(false)

  function handleCopyNetworkUrl(): void {
    if (!networkUrl) return
    void copyToClipboard(networkUrl).then((ok) => {
      if (ok) toast.success("Copied network URL")
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="Settings and more" title="Settings and more" className="rounded-md" />}
        >
          <Settings data-icon="inline-start" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="end" sideOffset={6} className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onOpenCommandPalette}>
              <Search />
              Search and commands
              <span className="ml-auto pl-2 font-mono text-[11px] text-muted-foreground">
                {shortcutLabel("commandPalette")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenSettings}>
              <Settings />
              Settings
            </DropdownMenuItem>
            {can("configWrite") && (
              <>
                <DropdownMenuItem onClick={onOpenPlugins}>
                  <Puzzle />
                  Plugins
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onOpenAgentFiles}>
                  <SlidersHorizontal />
                  Agent files
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {canViewUsage && (
              <DropdownMenuItem onClick={() => setUsageOpen(true)}>
                <ChartColumn />
                Usage &amp; cost…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onMonitorOpenChange(true)}>
              <Activity />
              Server monitor…
            </DropdownMenuItem>
            {networkUrl && (
              <DropdownMenuItem onClick={handleCopyNetworkUrl}>
                <Globe className="text-success" />
                Copy network URL
                <span className="ml-auto truncate pl-2 font-mono text-[11px] text-muted-foreground">
                  {networkUrl}
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Help &amp; docs</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => window.open(DOCUMENTATION_URL, "_blank", "noopener,noreferrer")}>
              <BookOpen />
              Documentation
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenKeyboardShortcuts}>
              <Keyboard />
              Keyboard shortcuts
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.open(REPORT_ISSUE_URL, "_blank", "noopener,noreferrer")}>
              <Bug />
              Report an issue
            </DropdownMenuItem>
            {update.status === "available" && (
              <DropdownMenuItem onClick={() => window.open(update.url, "_blank", "noopener,noreferrer")}>
                <ArrowUpRight />
                Cogpit v{update.version} release notes
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          {can("killAny") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem variant="destructive" onClick={onKillAll} disabled={killing}>
                  <Skull />
                  {killing ? "Stopping processes…" : "Stop all agent processes"}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {canViewUsage && <UsageCostDialog open={usageOpen} onOpenChange={setUsageOpen} />}
      <PowerMonitor open={monitorOpen} onOpenChange={onMonitorOpenChange} />
    </>
  )
}
