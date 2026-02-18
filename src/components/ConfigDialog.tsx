import { useState, useCallback, useEffect } from "react"
import { FolderOpen, CheckCircle, XCircle, Loader2, Eye, EyeOff, Wifi, WifiOff } from "lucide-react"
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

  // Track whether network settings changed (to enable save without path change)
  const [initialNetworkAccess, setInitialNetworkAccess] = useState(false)
  const [hasExistingPassword, setHasExistingPassword] = useState(false)

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
    })
    if (result.success && result.claudeDir) {
      onSaved(result.claudeDir)
    }
    setSaving(false)
  }, [path, networkAccess, networkPassword, save, onSaved])

  const networkChanged = networkAccess !== initialNetworkAccess || (networkAccess && networkPassword.length > 0)
  const pathChanged = status === "valid"
  const canSave = (pathChanged || networkChanged) && status !== "validating" && status !== "invalid"

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
              value={path}
              onChange={handleChange}
              placeholder="/Users/you/.claude"
              className="pl-10 bg-zinc-950 border-zinc-700 focus:border-zinc-600"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSave && !saving) handleSave()
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
                {networkAccess ? (
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
                aria-checked={networkAccess}
                onClick={() => setNetworkAccess(!networkAccess)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                  networkAccess ? "bg-green-600" : "bg-zinc-700"
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
                <label className="text-xs text-zinc-400">
                  Password {hasExistingPassword && networkPassword.length === 0 && <span className="text-zinc-600">(already set — leave blank to keep)</span>}
                </label>
                <div className="relative">
                  <Input
                    type={showNetworkPassword ? "text" : "password"}
                    value={networkPassword}
                    onChange={(e) => setNetworkPassword(e.target.value)}
                    placeholder={hasExistingPassword ? "Enter new password to change" : "Set a password for remote access"}
                    className="pr-10 bg-zinc-950 border-zinc-700 focus:border-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNetworkPassword(!showNetworkPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                  >
                    {showNetworkPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>
                <p className="text-[11px] text-zinc-600">
                  Requires app restart to take effect. Port: 19384
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
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
