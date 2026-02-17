import { useState, useCallback, useEffect } from "react"
import { FolderOpen, CheckCircle, XCircle, Loader2 } from "lucide-react"
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

  // Reset when dialog opens
  useEffect(() => {
    if (open) {
      setPath(currentPath)
      reset()
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
    const result = await save(path)
    if (result.success && result.claudeDir) {
      onSaved(result.claudeDir)
    }
    setSaving(false)
  }, [path, save, onSaved])

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
                if (e.key === "Enter" && status === "valid" && !saving) handleSave()
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
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            Cancel
          </Button>
          <Button disabled={status !== "valid" || saving} onClick={handleSave}>
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
