import { Eye, EyeOff, Wifi, WifiOff, Smartphone, Tablet, Monitor } from "lucide-react"
import { Input } from "@/components/ui/input"

function DeviceIcon({ name }: { name: string }) {
  const n = name.toLowerCase()
  if (n.includes("iphone") || n.includes("android")) return <Smartphone className="size-4 text-muted-foreground" />
  if (n.includes("ipad") || n.includes("tablet")) return <Tablet className="size-4 text-muted-foreground" />
  return <Monitor className="size-4 text-muted-foreground" />
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
    <div className="space-y-3 pt-3 border-t border-border">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {networkAccess ? (
            <Wifi className="size-4 text-green-400" />
          ) : (
            <WifiOff className="size-4 text-muted-foreground" />
          )}
          <div>
            <p className="text-sm font-medium text-foreground">Network Access</p>
            <p className="text-xs text-muted-foreground">Allow other devices to connect</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={networkAccess}
          onClick={() => setNetworkAccess(!networkAccess)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            networkAccess ? "bg-green-600" : "bg-accent"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              networkAccess ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {networkAccess && (
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">
            Password {hasExistingPassword && networkPassword.length === 0 && <span className="text-muted-foreground">(already set — leave blank to keep)</span>}
          </label>
          <div className="relative">
            <Input
              type={showNetworkPassword ? "text" : "password"}
              value={networkPassword}
              onChange={(e) => setNetworkPassword(e.target.value)}
              placeholder={hasExistingPassword ? "Enter new password to change" : "Set a password for remote access"}
              className="pr-10 bg-elevation-0 border-border/70 focus:border-border"
            />
            <button
              type="button"
              onClick={() => setShowNetworkPassword(!showNetworkPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showNetworkPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
          {networkPassword.length > 0 && networkPassword.length < minPasswordLength && (
            <p className="text-[11px] text-amber-500">
              Password must be at least {minPasswordLength} characters ({networkPassword.length}/{minPasswordLength})
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Requires app restart to take effect. Port: 19384
          </p>
        </div>
      )}

      {/* Connected devices */}
      {networkAccess && initialNetworkAccess && connectedDevices.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs text-muted-foreground">Connected devices</p>
          <div className="space-y-1.5">
            {connectedDevices.map((device, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border border-border bg-elevation-0 px-3 py-2">
                <div className="flex items-center gap-2.5">
                  <DeviceIcon name={device.deviceName} />
                  <div>
                    <p className="text-sm text-foreground">{device.deviceName}</p>
                    <p className="text-[11px] text-muted-foreground">{device.ip}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-green-500" />
                  <span className="text-[11px] text-muted-foreground">{formatTimeAgo(device.lastActivity)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
