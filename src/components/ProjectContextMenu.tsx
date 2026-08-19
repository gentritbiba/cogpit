import { useState, useRef } from "react"
import { Pencil } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"

interface ProjectContextMenuProps {
  children: React.ReactNode
  projectLabel: string
  customName?: string
  /** Extra classes for the trigger wrapper (e.g. sticky positioning). */
  className?: string
  onRename: (name: string) => void
}

export function ProjectContextMenu({
  children,
  projectLabel,
  customName,
  className,
  onRename,
}: ProjectContextMenuProps) {
  const [showRename, setShowRename] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const renameInputRef = useRef<HTMLInputElement>(null)

  function openRename(): void {
    setRenameValue(customName || "")
    setShowRename(true)
    requestAnimationFrame(() => renameInputRef.current?.select())
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<div className={cn("w-full", className)} />}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuGroup>
            <ContextMenuItem onClick={openRename}>
              <Pencil data-icon="inline-start" />
              Rename project
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={showRename} onOpenChange={setShowRename}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-foreground">Rename project</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Give this project a custom name. Clear to reset to default.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              onRename(renameValue)
              setShowRename(false)
            }}
          >
            <Field>
              <FieldLabel htmlFor="project-rename">Project name</FieldLabel>
              <Input
                id="project-rename"
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder={projectLabel}
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowRename(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
