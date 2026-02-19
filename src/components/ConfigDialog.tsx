import { useReducer, useState, useCallback, useEffect } from "react"
import { FolderOpen, CheckCircle, XCircle, Loader2, Eye, EyeOff, Wifi, WifiOff, Smartphone, Tablet, Monitor } from "lucide-react"
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
  if (n.includes("iphone") || n.includes("android")) return <Smartphone className="size-4 text-zinc-500" />
  if (n.includes("ipad") || n.includes("tablet")) return <Tablet className="size-4 text-zinc-500" />
  return <Monitor className="size-4 text-zinc-500" />
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

type Device = { ip: string; deviceName: string; lastActivity: number }

interface ConfigState {
  path: string
  saving: boolean
  networkAccess: boolean
  networkPassword: string
  showNetworkPassword: boolean
  initialNetworkAccess: boolean
  hasExistingPassword: boolean
  connectedDevices: Device[]
}

const initialState: ConfigState = {
  path: "",
  saving: false,
  networkAccess: false,
  networkPassword: "",
  showNetworkPassword: false,
  initialNetworkAccess: false,
  hasExistingPassword: false,
  connectedDevices: [],
}

type ConfigAction =
  | { type: "RESET"; path: string }
  | { type: "SET_PATH"; path: string }
  | { type: "SET_SAVING"; saving: boolean }
  | { type: "TOGGLE_NETWORK" }
  | { type: "SET_PASSWORD"; password: string }
  | { type: "TOGGLE_SHOW_PASSWORD" }
  | { type: "CONFIG_LOADED"; networkAccess: boolean; hasExistingPassword: boolean }
  | { type: "SET_DEVICES"; devices: Device[] }

function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
  switch (action.type) {
    case "RESET":
      return { ...initialState, path: action.path }
    case "SET_PATH":
      return { ...state, path: action.path }
    case "SET_SAVING":
      return { ...state, saving: action.saving }
    case "TOGGLE_NETWORK":
      return { ...state, networkAccess: !state.networkAccess }
    case "SET_PASSWORD":
      return { ...state, networkPassword: action.password }
    case "TOGGLE_SHOW_PASSWORD":
      return { ...state, showNetworkPassword: !state.showNetworkPassword }
    case "CONFIG_LOADED":
      return {
        ...state,
        networkAccess: action.networkAccess,
        initialNetworkAccess: action.networkAccess,
        hasExistingPassword: action.hasExistingPassword,
        networkPassword: "",
      }
    case "SET_DEVICES":
      return { ...state, connectedDevices: action.devices }
    default:
      return state
  }
}

interface ConfigDialogProps {
  open: boolean
  currentPath: string
  onClose: () => void
  onSaved: (newPath: string) => void
}

export function ConfigDialog({ open, currentPath, onClose, onSaved }: ConfigDialogProps) {
  const [state, dispatch] = useReducer(configReducer, initialState)
  const { status, error, debouncedValidate, reset, save } = useConfigValidation()

  // "Adjust state during render" — sync reset when dialog opens
  const [prevOpen, setPrevOpen] = useState(false)
  if (open && !prevOpen) {
    setPrevOpen(true)
    dispatch({ type: "RESET", path: currentPath })
    reset()
  }
  if (!open && prevOpen) {
    setPrevOpen(false)
  }

  // Async fetch when dialog opens (no sync setState here)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    authFetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const access = data?.networkAccess || false
        dispatch({ type: "CONFIG_LOADED", networkAccess: access, hasExistingPassword: !!data?.networkPassword })
        if (access && data?.networkPassword) {
          authFetch("/api/connected-devices")
            .then((r) => r.json())
            .then((d) => { if (!cancelled) dispatch({ type: "SET_DEVICES", devices: d?.devices || [] }) })
            .catch(() => {})
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open, currentPath])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      dispatch({ type: "SET_PATH", path: value })
      debouncedValidate(value)
    },
    [debouncedValidate]
  )

  const handleSave = useCallback(async () => {
    dispatch({ type: "SET_SAVING", saving: true })
    const result = await save(state.path, {
      networkAccess: state.networkAccess,
      networkPassword: state.networkAccess && state.networkPassword.length > 0 ? state.networkPassword : undefined,
    })
    if (result.success && result.claudeDir) {
      onSaved(result.claudeDir)
    }
    dispatch({ type: "SET_SAVING", saving: false })
  }, [state.path, state.networkAccess, state.networkPassword, save, onSaved])

  const MIN_PASSWORD_LENGTH = 12
  const networkChanged = state.networkAccess !== state.initialNetworkAccess || (state.networkAccess && state.networkPassword.length > 0)
  const pathChanged = status === "valid"
  const passwordTooShort = state.networkAccess && state.networkPassword.length > 0 && state.networkPassword.length < MIN_PASSWORD_LENGTH
  const needsPassword = state.networkAccess && !state.hasExistingPassword && state.networkPassword.length === 0
  const canSave = (pathChanged || networkChanged) && status !== "validating" && status !== "invalid" && !passwordTooShort && !needsPassword

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md bg-zinc-900 border-zinc-700">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Configuration</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Change the path to your .claude directory.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <FolderOpen className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <Input
              value={state.path}
              onChange={handleChange}
              placeholder="/Users/you/.claude"
              className="pl-10 bg-zinc-950 border-zinc-700 focus:border-zinc-600"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave && !state.saving) handleSave()
              }}
            />
          </div>

          {status === "validating" && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Loader2 className="size-3.5 animate-spin" />
              Checking path...
            </div>
          )}
          {status === "valid" && (
            <div className="flex items-center gap-2 text-sm text-green-400">
              <CheckCircle className="size-3.5" />
              Valid .claude directory found
            </div>
          )}
          {status === "invalid" && error && (
            <div className="flex items-center gap-2 text-sm text-red-400">
              <XCircle className="size-3.5" />
              {error}
            </div>
          )}

          {/* Network Access */}
          <div className="space-y-3 pt-3 border-t border-zinc-800">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {state.networkAccess ? (
                  <Wifi className="size-4 text-green-400" />
                ) : (
                  <WifiOff className="size-4 text-zinc-500" />
                )}
                <div>
                  <p className="text-sm font-medium text-zinc-200">Network Access</p>
                  <p className="text-xs text-zinc-500">Allow other devices to connect</p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={state.networkAccess}
                onClick={() => dispatch({ type: "TOGGLE_NETWORK" })}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                  state.networkAccess ? "bg-green-600" : "bg-zinc-700"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                    state.networkAccess ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {state.networkAccess && (
              <div className="space-y-2">
                <label className="text-xs text-zinc-400">
                  Password {state.hasExistingPassword && state.networkPassword.length === 0 && <span className="text-zinc-600">(already set — leave blank to keep)</span>}
                </label>
                <div className="relative">
                  <Input
                    type={state.showNetworkPassword ? "text" : "password"}
                    value={state.networkPassword}
                    onChange={(e) => dispatch({ type: "SET_PASSWORD", password: e.target.value })}
                    placeholder={state.hasExistingPassword ? "Enter new password to change" : "Set a password for remote access"}
                    className="pr-10 bg-zinc-950 border-zinc-700 focus:border-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "TOGGLE_SHOW_PASSWORD" })}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                  >
                    {state.showNetworkPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                {state.networkPassword.length > 0 && state.networkPassword.length < MIN_PASSWORD_LENGTH && (
                  <p className="text-[11px] text-amber-500">
                    Password must be at least {MIN_PASSWORD_LENGTH} characters ({state.networkPassword.length}/{MIN_PASSWORD_LENGTH})
                  </p>
                )}
                <p className="text-[11px] text-zinc-600">
                  Requires app restart to take effect. Port: 19384
                </p>
              </div>
            )}

            {/* Connected devices */}
            {state.networkAccess && state.initialNetworkAccess && state.connectedDevices.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-xs text-zinc-500">Connected devices</p>
                <div className="space-y-1.5">
                  {state.connectedDevices.map((device) => (
                    <div key={device.ip} className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
                      <div className="flex items-center gap-2.5">
                        <DeviceIcon name={device.deviceName} />
                        <div>
                          <p className="text-sm text-zinc-200">{device.deviceName}</p>
                          <p className="text-[11px] text-zinc-600">{device.ip}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="size-1.5 rounded-full bg-green-500" />
                        <span className="text-[11px] text-zinc-500">{formatTimeAgo(device.lastActivity)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            Cancel
          </Button>
          <Button disabled={!canSave || state.saving} onClick={handleSave}>
            {state.saving ? (
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
