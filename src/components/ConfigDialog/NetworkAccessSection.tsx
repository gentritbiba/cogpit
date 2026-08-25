import { Eye, EyeOff, Wifi, WifiOff, Smartphone, Tablet, Monitor } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { useShares, type HostShare } from "@/hooks/useShare"

function DeviceIcon({ name }: { name: string }) {
  const n = name.toLowerCase()
  if (n.includes("iphone") || n.includes("android")) return <Smartphone data-icon="inline-start" className="size-4 text-muted-foreground" />
  if (n.includes("ipad") || n.includes("tablet")) return <Tablet data-icon="inline-start" className="size-4 text-muted-foreground" />
  return <Monitor data-icon="inline-start" className="size-4 text-muted-foreground" />
}

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000)
  if (diff < 60) return "just now"
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** One scannable line per share: how old it is, whether anyone ever opened it. */
function shareSummary(share: HostShare): string {
  const parts = [
    `Shared ${formatTimeAgo(share.createdAt)}`,
    // lastAccessAt is 0 until a guest arrives, which would date to 1970.
    share.lastAccessAt > 0 ? `opened ${formatTimeAgo(share.lastAccessAt)}` : "never opened",
  ]
  if (share.guests > 0) parts.push(share.guests === 1 ? "1 guest" : `${share.guests} guests`)
  return parts.join(" · ")
}

/**
 * Every session currently reachable by a share link. Nothing else in the app
 * lists them, so this is the only place a share that was enabled weeks ago and
 * forgotten becomes visible again — which is the whole reason it exists.
 */
function SharedSessionsList() {
  const { shares, revoke, revokeAll } = useShares()

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-6 items-center justify-between">
        <p className="text-xs text-muted-foreground">Shared sessions</p>
        {shares.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive hover:text-destructive"
            onClick={() => void revokeAll()}
          >
            Revoke all
          </Button>
        )}
      </div>

      {shares.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sessions are shared.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {shares.map((share) => {
            const label = share.title || share.sessionId
            return (
              <div
                key={share.sessionId}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">{shareSummary(share)}</p>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={`Revoke share of ${label}`}
                  className="text-destructive hover:text-destructive"
                  onClick={() => void revoke(share.sessionId)}
                >
                  Revoke
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface NetworkAccessSectionProps {
  networkAccess: boolean
  setNetworkAccess: (v: boolean) => void
  networkPassword: string
  setNetworkPassword: (v: string) => void
  showNetworkPassword: boolean
  setShowNetworkPassword: (v: boolean) => void
  hasExistingPassword: boolean
  initialNetworkAccess: boolean
  connectedDevices: Array<{ ip: string; deviceName: string; lastActivity: number }>
  minPasswordLength: number
}

export function NetworkAccessSection({
  networkAccess,
  setNetworkAccess,
  networkPassword,
  setNetworkPassword,
  showNetworkPassword,
  setShowNetworkPassword,
  hasExistingPassword,
  initialNetworkAccess,
  connectedDevices,
  minPasswordLength,
}: NetworkAccessSectionProps) {
  return (
    <div className="flex flex-col gap-4 border-t pt-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {networkAccess ? (
            <Wifi data-icon="inline-start" className="size-4 text-success" />
          ) : (
            <WifiOff data-icon="inline-start" className="size-4 text-muted-foreground" />
          )}
          <div>
            <p className="text-sm font-medium text-foreground">Network Access</p>
            <p className="text-xs text-muted-foreground">Allow other devices to connect</p>
          </div>
        </div>
        <Switch
          aria-label="Network Access"
          checked={networkAccess}
          onCheckedChange={(checked) => setNetworkAccess(checked)}
        />
      </div>

      {networkAccess && (
        <Field data-invalid={networkPassword.length > 0 && networkPassword.length < minPasswordLength}>
          <FieldLabel htmlFor="network-password">Password</FieldLabel>
          <FieldDescription>
            {hasExistingPassword && networkPassword.length === 0
              ? "A password is already set. Leave blank to keep it."
              : `Use at least ${minPasswordLength} characters.`}
          </FieldDescription>
          <InputGroup>
            <InputGroupInput
              id="network-password"
              type={showNetworkPassword ? "text" : "password"}
              value={networkPassword}
              onChange={(e) => setNetworkPassword(e.target.value)}
              placeholder={hasExistingPassword ? "Enter new password to change" : "Set a password for remote access"}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={showNetworkPassword ? "Hide password" : "Show password"}
                onClick={() => setShowNetworkPassword(!showNetworkPassword)}
              >
                {showNetworkPassword ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {networkPassword.length > 0 && networkPassword.length < minPasswordLength && (
            <FieldError>
              Password must be at least {minPasswordLength} characters ({networkPassword.length}/{minPasswordLength})
            </FieldError>
          )}
          <FieldDescription>
            Requires app restart. Remote browsers need an HTTPS reverse proxy;
            port 19384 remains available to Cogpit hubs and device clients.
          </FieldDescription>
        </Field>
      )}

      {networkAccess && initialNetworkAccess && connectedDevices.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Connected devices</p>
          <div className="flex flex-col gap-1.5">
            {connectedDevices.map((device, i) => (
              <div key={`${device.ip}-${i}`} className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <DeviceIcon name={device.deviceName} />
                  <div>
                    <p className="text-sm text-foreground">{device.deviceName}</p>
                    <p className="text-xs text-muted-foreground">{device.ip}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-success" />
                  <span className="text-xs text-muted-foreground">{formatTimeAgo(device.lastActivity)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <SharedSessionsList />
    </div>
  )
}
