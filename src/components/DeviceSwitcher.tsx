import { useCallback, useState } from "react"
import { Menu } from "@base-ui/react/menu"
import { Check, ChevronDown, Laptop, Plus, Server, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { LOCAL_DEVICE_ID, switchDevice } from "@/lib/device"
import { deviceVersion, useDevices, type PublicDevice } from "@/hooks/useDevices"
import { DevicesDialog } from "@/components/DevicesDialog"
import packageJson from "../../package.json"

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-sm text-foreground outline-none cursor-pointer select-none data-highlighted:bg-elevation-2 hover:bg-elevation-2"

const HUB_VERSION = packageJson.version

const STATUS_DOT: Record<PublicDevice["runtime"]["authState"], string> = {
  ok: "bg-green-500",
  unknown: "bg-amber-500",
  "bad-password": "bg-red-500",
}

const STATUS_LABEL: Record<PublicDevice["runtime"]["authState"], string> = {
  ok: "Reachable",
  unknown: "Not reachable",
  "bad-password": "Password rejected",
}

function StatusDot({ state }: { state: PublicDevice["runtime"]["authState"] }) {
  return (
    <span
      aria-label={STATUS_LABEL[state]}
      title={STATUS_LABEL[state]}
      className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[state])}
    />
  )
}

export function DeviceSwitcher() {
  const { devices, activeDeviceId, activeDevice, refresh, testDevice } = useDevices()
  const [dialogMode, setDialogMode] = useState<null | "add" | "manage">(null)

  const activeName = activeDevice?.name ?? "This machine"
  const activeIsRemote = activeDeviceId !== LOCAL_DEVICE_ID

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

  return (
    <>
      <Menu.Root onOpenChange={probeOnOpen}>
        <Menu.Trigger
          render={
            <button
              type="button"
              aria-label="Switch device"
              className="mr-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-elevation-2 hover:text-foreground"
            />
          }
        >
          {activeIsRemote ? <Server className="size-3 text-blue-400" /> : <Laptop className="size-3" />}
          <span className="max-w-[140px] truncate">{activeName}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Menu.Trigger>

        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50">
            <Menu.Popup className="min-w-[248px] rounded-lg elevation-3 border border-border/30 p-1">
              <div className="px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Devices
              </div>

              <Menu.Item
                className={MENU_ITEM_CLASS}
                onClick={() => switchDevice(LOCAL_DEVICE_ID)}
              >
                <Laptop className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">This machine</span>
                {!activeIsRemote && <Check className="size-3.5 shrink-0 text-green-400" />}
              </Menu.Item>

              {devices.map((device) => {
                const version = deviceVersion(device)
                const skewed = version !== undefined && version !== HUB_VERSION
                const isActive = device.id === activeDeviceId
                return (
                  <Menu.Item
                    key={device.id}
                    className={MENU_ITEM_CLASS}
                    onClick={() => switchDevice(device.id)}
                  >
                    <StatusDot state={device.runtime.authState} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{device.name}</span>
                        {version && (
                          <span
                            className={cn(
                              "shrink-0 text-[10px] font-mono",
                              skewed ? "text-amber-400" : "text-muted-foreground/60",
                            )}
                            title={skewed ? `Device runs v${version}; hub runs v${HUB_VERSION}` : undefined}
                          >
                            v{version}
                            {skewed && " ≠ hub"}
                          </span>
                        )}
                      </div>
                      <span className="truncate text-[11px] text-muted-foreground/70">
                        {device.host}:{device.port}
                        {device.auth === "none" && " · unauthenticated"}
                      </span>
                    </div>
                    {isActive && <Check className="size-3.5 shrink-0 text-green-400" />}
                  </Menu.Item>
                )
              })}

              <div className="my-1 h-px bg-border/40" />

              <Menu.Item className={MENU_ITEM_CLASS} onClick={() => setDialogMode("add")}>
                <Plus className="size-4 shrink-0 text-muted-foreground" />
                <span>Add device…</span>
              </Menu.Item>
              {devices.length > 0 && (
                <Menu.Item className={MENU_ITEM_CLASS} onClick={() => setDialogMode("manage")}>
                  <Settings2 className="size-4 shrink-0 text-muted-foreground" />
                  <span>Manage devices…</span>
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      <DevicesDialog
        open={dialogMode !== null}
        initialMode={dialogMode ?? "manage"}
        onClose={() => setDialogMode(null)}
      />
    </>
  )
}
