import { useState } from "react"
import * as ContextMenu from "@radix-ui/react-context-menu"
import { Copy, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

interface SessionContextMenuProps {
  children: React.ReactNode
  sessionLabel: string
  onDuplicate?: () => void
  onDelete?: () => void
}

export function SessionContextMenu({
  children,
  sessionLabel,
  onDuplicate,
  onDelete,
}: SessionContextMenuProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="min-w-[180px] rounded-lg elevation-3 border border-border/30 p-1 z-50">
            {onDuplicate && (
              <ContextMenu.Item
                className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-foreground outline-none cursor-pointer hover:bg-elevation-2 hover:text-foreground"
                onSelect={onDuplicate}
              >
                <Copy className="size-3.5" />
                Duplicate session
              </ContextMenu.Item>
            )}
            {onDelete && (
              <>
                {onDuplicate && (
                  <ContextMenu.Separator className="my-1 h-px bg-border" />
                )}
                <ContextMenu.Item
                  className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-red-400 outline-none cursor-pointer hover:bg-red-500/10 hover:text-red-300"
                  onSelect={() => setShowDeleteConfirm(true)}
                >
                  <Trash2 className="size-3.5" />
                  Delete session
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
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
    </>
  )
}
