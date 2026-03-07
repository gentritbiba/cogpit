import { useState, useRef, useEffect } from "react"
import { ContextMenu } from "@base-ui/react/context-menu"
import { Copy, Trash2, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

const MENU_ITEM_CLASS =
  "flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-foreground outline-none cursor-pointer hover:bg-elevation-2 hover:text-foreground"

interface SessionContextMenuProps {
  children: React.ReactNode
  sessionLabel: string
  customName?: string
  onDuplicate?: () => void
  onDelete?: () => void
  onRename?: (name: string) => void
}

export function SessionContextMenu({
  children,
  sessionLabel,
  customName,
  onDuplicate,
  onDelete,
  onRename,
}: SessionContextMenuProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (showRename) {
      setRenameValue(customName || "")
      setTimeout(() => renameInputRef.current?.select(), 0)
    }
  }, [showRename, customName])

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger render={<div className="w-full" />}>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner>
            <ContextMenu.Popup className="min-w-[180px] rounded-lg elevation-3 border border-border/30 p-1 z-50">
              {onRename && (
                <ContextMenu.Item
                  className={MENU_ITEM_CLASS}
                  onClick={() => setShowRename(true)}
                >
                  <Pencil className="size-3.5" />
                  Rename session
                </ContextMenu.Item>
              )}
              {onDuplicate && (
                <ContextMenu.Item
                  className={MENU_ITEM_CLASS}
                  onClick={onDuplicate}
                >
                  <Copy className="size-3.5" />
                  Duplicate session
                </ContextMenu.Item>
              )}
              {onDelete && (
                <>
                  {(onDuplicate || onRename) && (
                    <ContextMenu.Separator className="my-1 h-px bg-border" />
                  )}
                  <ContextMenu.Item
                    className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-red-400 outline-none cursor-pointer hover:bg-red-500/10 hover:text-red-300"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="size-3.5" />
                    Delete session
                  </ContextMenu.Item>
                </>
              )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="elevation-4 border-border/30 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-foreground">Delete session?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              This will permanently delete{" "}
              <span className="font-medium text-foreground">{sessionLabel}</span>.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setShowDeleteConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                onDelete?.()
                setShowDeleteConfirm(false)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showRename} onOpenChange={setShowRename}>
        <DialogContent className="elevation-4 border-border/30 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-foreground">Rename session</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Give this session a custom name. Clear to reset to default.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onRename?.(renameValue)
              setShowRename(false)
            }}
          >
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={sessionLabel}
              className="w-full rounded-lg border border-border/60 elevation-2 depth-low py-2 px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
            />
            <DialogFooter className="gap-2 sm:gap-0 mt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setShowRename(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
