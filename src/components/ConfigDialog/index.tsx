import { useState, useCallback, useEffect } from "react"
import { FolderOpen, CheckCircle, XCircle, Loader2, TerminalSquare, Code2 } from "lucide-react"
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { useConfigValidation } from "@/hooks/useConfigValidation"
import { authFetch } from "@/lib/auth"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { NetworkAccessSection } from "./NetworkAccessSection"

function ValidationStatus({ status, error }: { status: string; error: string | null }) {
  if (status === "validating") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 data-icon="inline-start" className="size-3.5 animate-spin" />
        Checking path...
      </div>
    )
  }
  if (status === "valid") {
    return (
      <div className="flex items-center gap-2 text-sm text-success">
        <CheckCircle data-icon="inline-start" className="size-3.5" />
        Valid .claude directory found
      </div>
    )
  }
  if (status === "invalid" && error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <XCircle data-icon="inline-start" className="size-3.5" />
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
  // Editing a remote device's network access through the proxy could rotate its
  // password or disable its network access — either one locks this hub out.
  const remoteDevice = isRemoteDeviceActive()
  // Team members without configWrite get a read-only view (server 403s anyway).
  const canWriteConfig = can("configWrite")

  // Network access state
  const [networkAccess, setNetworkAccess] = useState(false)
  const [networkPassword, setNetworkPassword] = useState("")
  const [showNetworkPassword, setShowNetworkPassword] = useState(false)

  // Terminal app
  const [terminalApp, setTerminalApp] = useState("")
  const [initialTerminalApp, setInitialTerminalApp] = useState("")

  // Editor app
  const [editorApp, setEditorApp] = useState("")
  const [initialEditorApp, setInitialEditorApp] = useState("")

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
          const editor = data?.editorApp || ""
          setEditorApp(editor)
          setInitialEditorApp(editor)
          // Fetch connected devices if network is active
          if (access && data?.networkPassword && !remoteDevice) {
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
  }, [open, currentPath, reset, remoteDevice])

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
      // Remote device: echo its current setting untouched — omitting the field
      // would disable its network access server-side and cut this hub off.
      networkAccess: remoteDevice ? initialNetworkAccess : networkAccess,
      // Only send password if user typed one (blank = keep existing)
      networkPassword: !remoteDevice && networkAccess && networkPassword.length > 0 ? networkPassword : undefined,
      terminalApp: terminalApp.trim() || undefined,
      editorApp: editorApp.trim() || undefined,
    })
    if (result.success && result.claudeDir) {
      onSaved(result.claudeDir)
    }
    setSaving(false)
  }, [path, networkAccess, networkPassword, terminalApp, editorApp, save, onSaved, remoteDevice, initialNetworkAccess])

  const MIN_PASSWORD_LENGTH = 16

  function computeCanSave(): boolean {
    // Block save while path is being validated or is invalid
    if (status === "validating" || status === "invalid") return false

    // Check if anything actually changed
    const pathChanged = status === "valid"
    const networkChanged = !remoteDevice && (networkAccess !== initialNetworkAccess || (networkAccess && networkPassword.length > 0))
    const terminalChanged = terminalApp !== initialTerminalApp
    const editorChanged = editorApp !== initialEditorApp
    if (!pathChanged && !networkChanged && !terminalChanged && !editorChanged) return false

    // Validate password requirements when network is enabled
    if (!remoteDevice && networkAccess) {
      const passwordTooShort = networkPassword.length > 0 && networkPassword.length < MIN_PASSWORD_LENGTH
      const needsPassword = !hasExistingPassword && networkPassword.length === 0
      if (passwordTooShort || needsPassword) return false
    }

    return true
  }

  const canSave = computeCanSave()

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground">Configuration</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Manage local paths, preferred apps, and remote access.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="claude-directory">Claude directory</FieldLabel>
            <FieldDescription>The directory containing your Claude configuration.</FieldDescription>
            <InputGroup>
              <InputGroupAddon>
                <FolderOpen data-icon="inline-start" />
              </InputGroupAddon>
              <InputGroupInput
                id="claude-directory"
                value={path}
                onChange={handleChange}
                placeholder="/Users/you/.claude"
                disabled={!canWriteConfig}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSave && !saving) handleSave()
                }}
              />
            </InputGroup>
            <div aria-live="polite">
              <ValidationStatus status={status} error={error} />
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor="terminal-application">
              <TerminalSquare data-icon="inline-start" className="size-4 text-muted-foreground" />
              Terminal application
            </FieldLabel>
            <FieldDescription>Leave blank to use the system default for Ctrl+Cmd+T.</FieldDescription>
            <Input
              id="terminal-application"
              value={terminalApp}
              onChange={(e) => setTerminalApp(e.target.value)}
              placeholder="Ghostty, iTerm, or /path/to/binary"
              disabled={!canWriteConfig}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="editor-application">
              <Code2 data-icon="inline-start" className="size-4 text-muted-foreground" />
              Editor application
            </FieldLabel>
            <FieldDescription>Leave blank to use $VISUAL or automatic detection.</FieldDescription>
            <Input
              id="editor-application"
              value={editorApp}
              onChange={(e) => setEditorApp(e.target.value)}
              placeholder="cursor, code, zed, or /path/to/binary"
              disabled={!canWriteConfig}
            />
          </Field>

          {/* Network Access — hidden for remote devices: changing it through the
              proxy would revoke the very sessions this hub depends on. Hidden
              without configWrite: the section is pure editing surface. */}
          {!remoteDevice && canWriteConfig && <NetworkAccessSection
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
          />}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {canWriteConfig && (
            <Button disabled={!canSave || saving} onClick={handleSave}>
              {saving ? (
                <>
                  <Loader2 data-icon="inline-start" className="size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
