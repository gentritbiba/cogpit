import { useState } from "react"
import { TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AppMenu } from "@/components/AppMenu"
import { DeviceSwitcher } from "@/components/DeviceSwitcher"
import { LeakIndicator } from "@/components/LeakIndicator"
import { TokenUsageIndicator } from "@/components/TokenUsageWidget"
import { UpdatesMenu } from "@/components/UpdatesMenu"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionControls } from "@/contexts/SessionContext"
import { useSessionInventoryOptional } from "@/contexts/SessionInventoryContext"
import { useEditionUi } from "@/edition/hooks"
import { agentKindForDirName } from "@/lib/agents"

interface AppDockProps {
  killing: boolean
  onKillAll: () => void
  onOpenSettings: () => void
  onOpenCommandPalette: () => void
  onOpenKeyboardShortcuts: () => void
  onOpenPlugins: () => void
  onOpenAgentFiles: () => void
  /** Absent where the user may not run a terminal. */
  onToggleTerminal?: () => void
  terminalShortcut: string
  onLogout: () => void
  /** Opens an edition main view, from the account control. */
  onOpenMainView: (id: string) => void
}

/**
 * The bottom of the rail: everything that is about the app or the machine
 * rather than the open session. Each readout shows only while it has
 * something to say, so at rest this is a terminal toggle and a menu.
 */
export function AppDock({
  killing,
  onKillAll,
  onOpenSettings,
  onOpenCommandPalette,
  onOpenKeyboardShortcuts,
  onOpenPlugins,
  onOpenAgentFiles,
  onToggleTerminal,
  terminalShortcut,
  onLogout,
  onOpenMainView,
}: AppDockProps) {
  const { config: { defaultAgentKind } } = useAppContext()
  const { sessionSource } = useSessionControls()
  const inventory = useSessionInventoryOptional()
  const { AccountControl } = useEditionUi()
  const [monitorOpen, setMonitorOpen] = useState(false)
  const activeAgentKind = sessionSource
    ? sessionSource.agentKind ?? agentKindForDirName(sessionSource.dirName)
    : defaultAgentKind

  return (
    <>
      {/* The scan sees every agent process on the machine; before any session it can only be another app's. */}
      {(!inventory || inventory.sessions.length > 0) && <LeakIndicator onReview={() => setMonitorOpen(true)} />}
      <TokenUsageIndicator agentKind={activeAgentKind} />
      <DeviceSwitcher />
      <UpdatesMenu />
      {onToggleTerminal && (
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Terminal"
                onClick={onToggleTerminal}
                className="rounded-md"
              />
            )}
          >
            <TerminalSquare data-icon="inline-start" />
          </TooltipTrigger>
          <TooltipContent side="left">Terminal ({terminalShortcut})</TooltipContent>
        </Tooltip>
      )}
      <AppMenu
        killing={killing}
        onKillAll={onKillAll}
        onOpenSettings={onOpenSettings}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
        onOpenPlugins={onOpenPlugins}
        onOpenAgentFiles={onOpenAgentFiles}
        monitorOpen={monitorOpen}
        onMonitorOpenChange={setMonitorOpen}
      />
      {AccountControl && <AccountControl onLogout={onLogout} onOpenMainView={onOpenMainView} />}
    </>
  )
}
