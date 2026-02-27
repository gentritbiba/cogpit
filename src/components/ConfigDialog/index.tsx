import { useState, useCallback, useEffect } from "react"
import { FolderOpen, CheckCircle, XCircle, Loader2, TerminalSquare } from "lucide-react"
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
import { NetworkAccessSection } from "./NetworkAccessSection"

// Re-export extracted modules so external imports remain unchanged
export { NetworkAccessSection } from "./NetworkAccessSection"

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
          <NetworkAccessSection
            networkAccess={networkAccess}
            setNetworkAccess={setNetworkAccess}
            networkPassword={networkPassword}
            setNetworkPassword={setNetworkPassword}
            showNetworkPassword={showNetworkPassword}
            setShowNetworkPassword={setShowNetworkPassword}
            hasExistingPassword={hasExistingPassword}
            initialNetworkAccess={initialNetworkAccess}
            connectedDevices={connectedDevices}
            minPasswordLength={MIN_PASSWORD_LENGTH}
          />
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
