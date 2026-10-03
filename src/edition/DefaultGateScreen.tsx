import { Laptop, LogOut, RefreshCw, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useDevices } from "@/hooks/useDevices"
import { isRemoteDeviceActive, LOCAL_DEVICE_ID, switchDevice } from "@/lib/device"
import type { GateScreenProps } from "./contract"

/**
 * The whole app while the server keeps the caller out and no edition UI says
 * why. Check again hands back to the app, which asks the server afresh. On a
 * remote device the way out is back to this machine, since signing out would
 * end the hub's own session.
 */
export function DefaultGateScreen({ onRestored, onLogout }: GateScreenProps) {
  const { activeDevice, activeDeviceId } = useDevices()
  const remote = isRemoteDeviceActive()
  const server = remote ? activeDevice?.name ?? activeDeviceId : "This server"

  return (
    <div className="dark flex h-dvh items-center justify-center bg-canvas text-foreground">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlert className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle>{server} isn’t available to your account right now</EmptyTitle>
          <EmptyDescription>Its administrator can let you back in. Check again once they have.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button size="sm" onClick={onRestored}>
            <RefreshCw data-icon="inline-start" />
            Check again
          </Button>
          {remote ? (
            <Button variant="outline" size="sm" onClick={() => switchDevice(LOCAL_DEVICE_ID)}>
              <Laptop data-icon="inline-start" />
              Switch to this machine
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onLogout}>
              <LogOut data-icon="inline-start" />
              Sign out
            </Button>
          )}
        </EmptyContent>
      </Empty>
    </div>
  )
}
