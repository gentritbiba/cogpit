import { useCallback, useState } from "react"
import { Check, ChevronDown, Laptop, Plus, Server, Settings2 } from "lucide-react"
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
import { cn } from "@/lib/utils"
import { can } from "@/lib/capabilities"
import { LOCAL_DEVICE_ID, switchDevice } from "@/lib/device"
import { deviceVersion, useDevices, type PublicDevice } from "@/hooks/useDevices"
import { DevicesDialog } from "@/components/DevicesDialog"
import packageJson from "../../package.json"

const HUB_VERSION = packageJson.version

const AUTH_STATE_DOT: Record<PublicDevice["runtime"]["authState"], string> = {
  ok: "bg-success",
  unknown: "bg-warning",
  "bad-password": "bg-destructive",
}

const AUTH_STATE_LABEL: Record<PublicDevice["runtime"]["authState"], string> = {
  ok: "Reachable",
  unknown: "Not reachable",
  "bad-password": "Password rejected",
}

function StatusDot({ state }: { state: PublicDevice["runtime"]["authState"] }) {
  return (
    <span
      aria-label={AUTH_STATE_LABEL[state]}
      title={AUTH_STATE_LABEL[state]}
      className={cn("size-2 shrink-0 rounded-full", AUTH_STATE_DOT[state])}
    />
  )
}

export function DeviceSwitcher({ compact = false }: { compact?: boolean }) {
  const { devices, activeDeviceId, activeDevice, refresh, testDevice } = useDevices()
  const [dialogMode, setDialogMode] = useState<null | "add" | "manage">(null)

  const activeName = activeDevice?.name ?? "This machine"
  const activeIsRemote = activeDeviceId !== LOCAL_DEVICE_ID
  const canManageDevices = can("manageDevices")

  // Probe every device once when the dropdown opens — the only probing that
  // happens; there is no background polling.
  const probeOnOpen = useCallback(
    (open: boolean) => {
      if (!open || devices.length === 0) return
      void Promise.all(devices.map((device) => testDevice(device.id).catch(() => null))).then(
        () => refresh(),
      )
    },
    [devices, testDevice, refresh],
  )

  // With no remote devices this only ever reads "This machine". Desktop keeps
  // device management in the command palette; the compact (mobile) variant has
  // no palette behind it, so it stays put as the only way in.
  if (!compact && devices.length === 0 && !activeIsRemote) return null

  return (
    <>
      <DropdownMenu onOpenChange={probeOnOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size={compact ? "sm" : "xs"}
              aria-label="Switch device"
              className={cn(
                "max-w-40 justify-start",
                compact && "h-10",
              )}
            />
          }
        >
          {activeIsRemote ? <Server data-icon="inline-start" /> : <Laptop data-icon="inline-start" />}
          <span className="truncate">{activeName}</span>
          <ChevronDown data-icon="inline-end" className="opacity-60" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={6} className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Devices</DropdownMenuLabel>

            <DropdownMenuItem onClick={() => switchDevice(LOCAL_DEVICE_ID)}>
              <Laptop />
              <span className="flex-1 truncate">This machine</span>
              {!activeIsRemote && <Check className="ml-auto text-success" />}
            </DropdownMenuItem>

            {devices.map((device) => {
              const version = deviceVersion(device)
              const skewed = version !== undefined && version !== HUB_VERSION
              const isActive = device.id === activeDeviceId
              return (
                <DropdownMenuItem
                  key={device.id}
                  onClick={() => switchDevice(device.id)}
                  className={cn(compact && "min-h-10")}
                >
                  <StatusDot state={device.runtime.authState} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{device.name}</span>
                      {skewed && (
                        <span
                          className="shrink-0 font-mono text-xs text-warning"
                          title={`Device runs v${version}; hub runs v${HUB_VERSION}`}
                        >
                          v{version}
                        </span>
                      )}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {device.host}:{device.port}
                      {device.auth === "none" && " · unauthenticated"}
                    </span>
                  </div>
                  {isActive && <Check className="ml-auto text-success" />}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>

          {canManageDevices && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setDialogMode("add")}>
                  <Plus />
                  <span>Add device…</span>
                </DropdownMenuItem>
                {devices.length > 0 && (
                  <DropdownMenuItem onClick={() => setDialogMode("manage")}>
                    <Settings2 />
                    <span>Manage devices…</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {canManageDevices && (
        <DevicesDialog
          open={dialogMode !== null}
          initialMode={dialogMode ?? "manage"}
          onClose={() => setDialogMode(null)}
        />
      )}
    </>
  )
}
