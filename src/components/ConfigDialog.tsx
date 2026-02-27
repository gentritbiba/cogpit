import { useState, useCallback, useEffect } from "react"
import { FolderOpen, CheckCircle, XCircle, Loader2, Eye, EyeOff, Wifi, WifiOff, Smartphone, Tablet, Monitor, TerminalSquare } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useConfigValidation } from "@/hooks/useConfigValidation"
import { authFetch } from "@/lib/auth"

function DeviceIcon({ name }: { name: string }) {
  const n = name.toLowerCase()
  if (n.includes("iphone") || n.includes("android")) return <Smartphone className="size-4 text-muted-foreground" />
  if (n.includes("ipad") || n.includes("tablet")) return <Tablet className="size-4 text-muted-foreground" />
  return <Monitor className="size-4 text-muted-foreground" />
}

function ValidationStatus({ status, error }: { status: string; error: string | null }) {
  if (status === "validating") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Checking path...
      </div>
    )
  }
  if (status === "valid") {
    return (
      <div className="flex items-center gap-2 text-sm text-green-400">
        <CheckCircle className="size-3.5" />
        Valid .claude directory found
      </div>
    )
  }
  if (status === "invalid" && error) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-400">
        <XCircle className="size-3.5" />
        {error}
      </div>
    )
  }
  return null
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

interface ConfigDialogProps {
  open: boolean
  currentPath: string
  onClose: () => void
  onSaved: (newPath: string) => void
}

export function ConfigDialog({ open, currentPath, onClose, onSaved }: ConfigDialogProps) {
  const [path, setPath] = useState(currentPath)
  const [saving, setSaving] = useState(false)
  const { status, error, debouncedValidate, reset, save } = useConfigValidation()

  // Network access state
  const [networkAccess, setNetworkAccess] = useState(false)
  const [networkPassword, setNetworkPassword] = useState("")
  const [showNetworkPassword, setShowNetworkPassword] = useState(false)

  // Terminal app
  const [terminalApp, setTerminalApp] = useState("")
  const [initialTerminalApp, setInitialTerminalApp] = useState("")

  // Track whether network settings changed (to enable save without path change)
  const [initialNetworkAccess, setInitialNetworkAccess] = useState(false)
  const [hasExistingPassword, setHasExistingPassword] = useState(false)

  // Connected devices
  const [connectedDevices, setConnectedDevices] = useState<Array<{ ip: string; deviceName: string; lastActivity: number }>>([])

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      setPath(currentPath)
      reset()
      // Fetch current network settings
      authFetch("/api/config")
        .then((res) => res.json())
        .then((data) => {
          const access = data?.networkAccess || false
          setNetworkAccess(access)
          setInitialNetworkAccess(access)
          setHasExistingPassword(!!data?.networkPassword)
          setNetworkPassword("")
          const term = data?.terminalApp || ""
          setTerminalApp(term)
          setInitialTerminalApp(term)
          // Fetch connected devices if network is active
          if (access && data?.networkPassword) {
            authFetch("/api/connected-devices")
              .then((r) => r.json())
              .then((d) => setConnectedDevices(d?.devices || []))
              .catch(() => {})
          } else {
            setConnectedDevices([])
          }
        })
        .catch(() => {})
    }
  }, [open, currentPath, reset])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setPath(value)
      debouncedValidate(value)
    },
    [debouncedValidate]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    const result = await save(path, {
      networkAccess,
      // Only send password if user typed one (blank = keep existing)
      networkPassword: networkAccess && networkPassword.length > 0 ? networkPassword : undefined,
      terminalApp: terminalApp.trim() || undefined,
    })
    if (result.success && result.claudeDir) {
      onSaved(result.claudeDir)
    }
    setSaving(false)
  }, [path, networkAccess, networkPassword, terminalApp, save, onSaved])

  const MIN_PASSWORD_LENGTH = 12

  function computeCanSave(): boolean {
    // Block save while path is being validated or is invalid
    if (status === "validating" || status === "invalid") return false

    // Check if anything actually changed
    const pathChanged = status === "valid"
    const networkChanged = networkAccess !== initialNetworkAccess || (networkAccess && networkPassword.length > 0)
    const terminalChanged = terminalApp !== initialTerminalApp
    if (!pathChanged && !networkChanged && !terminalChanged) return false

    // Validate password requirements when network is enabled
    if (networkAccess) {
      const passwordTooShort = networkPassword.length > 0 && networkPassword.length < MIN_PASSWORD_LENGTH
      const needsPassword = !hasExistingPassword && networkPassword.length === 0
      if (passwordTooShort || needsPassword) return false
    }

    return true
  }

  const canSave = computeCanSave()

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md elevation-4 border-border/30">
        <DialogHeader>
          <DialogTitle className="text-foreground">Configuration</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Change the path to your .claude directory.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <FolderOpen className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={path}
              onChange={handleChange}
              placeholder="/Users/you/.claude"
              className="pl-10 bg-elevation-0 border-border/70 focus:border-border"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave && !saving) handleSave()
              }}
            />
          </div>

          <ValidationStatus status={status} error={error} />

          {/* Terminal App */}
          <div className="space-y-2 pt-3 border-t border-border">
            <div className="flex items-center gap-2">
              <TerminalSquare className="size-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium text-foreground">Terminal Application</p>
                <p className="text-xs text-muted-foreground">Custom terminal for Ctrl+Cmd+T (blank = system default)</p>
              </div>
            </div>
            <Input
              value={terminalApp}
              onChange={(e) => setTerminalApp(e.target.value)}
              placeholder="Ghostty, iTerm, or /path/to/binary"
              className="bg-elevation-0 border-border/70 focus:border-border text-sm"
            />
          </div>

          {/* Network Access */}
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
                {networkPassword.length > 0 && networkPassword.length < MIN_PASSWORD_LENGTH && (
                  <p className="text-[11px] text-amber-500">
                    Password must be at least {MIN_PASSWORD_LENGTH} characters ({networkPassword.length}/{MIN_PASSWORD_LENGTH})
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
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            Cancel
          </Button>
          <Button disabled={!canSave || saving} onClick={handleSave}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin mr-2" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
