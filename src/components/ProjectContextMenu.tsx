import { useState, useRef, useEffect } from "react"
import { ContextMenu } from "@base-ui/react/context-menu"
import { Pencil } from "lucide-react"
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

interface ProjectContextMenuProps {
  children: React.ReactNode
  projectLabel: string
  customName?: string
  onRename: (name: string) => void
}

export function ProjectContextMenu({
  children,
  projectLabel,
  customName,
  onRename,
}: ProjectContextMenuProps) {
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
              <ContextMenu.Item
                className={MENU_ITEM_CLASS}
                onClick={() => setShowRename(true)}
              >
                <Pencil className="size-3.5" />
                Rename project
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <Dialog open={showRename} onOpenChange={setShowRename}>
        <DialogContent className="elevation-4 border-border/30 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-foreground">Rename project</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Give this project a custom name. Clear to reset to default.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onRename(renameValue)
              setShowRename(false)
            }}
          >
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={projectLabel}
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
