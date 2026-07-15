import { useEffect, useMemo, useState } from "react"
import { Keyboard, RotateCcw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  KEYBINDING_DEFINITIONS,
  findKeybindingConflict,
  formatShortcut,
  getResolvedKeybindings,
  resetAllKeybindings,
  resetKeybinding,
  setKeybinding,
  shortcutFromKeyboardEvent,
  type KeybindingCommand,
} from "@/lib/keybindings"

interface KeyboardShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"])

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  const [query, setQuery] = useState("")
  const [recording, setRecording] = useState<KeybindingCommand | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [bindings, setBindings] = useState(getResolvedKeybindings)

  useEffect(() => {
    if (!open) return
    setQuery("")
    setRecording(null)
    setConflict(null)
    setBindings(getResolvedKeybindings())
  }, [open])

  useEffect(() => {
    if (!recording) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        setRecording(null)
        setConflict(null)
        return
      }
      if (modifierKeys.has(event.key)) return

      event.preventDefault()
      event.stopPropagation()
      const shortcut = shortcutFromKeyboardEvent(event)
      const duplicate = findKeybindingConflict(shortcut, recording)
      if (duplicate) {
        setConflict(`Already assigned to “${duplicate.label}”.`)
        return
      }
      setKeybinding(recording, shortcut)
      setBindings(getResolvedKeybindings())
      setRecording(null)
      setConflict(null)
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [recording])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return KEYBINDING_DEFINITIONS
    return KEYBINDING_DEFINITIONS.filter((definition) =>
      `${definition.label} ${definition.description} ${definition.group}`
        .toLowerCase()
        .includes(normalized),
    )
  }, [query])

  const groups = ["General", "View", "Tools"] as const

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="p-4 pb-3">
          <DialogTitle className="flex items-center gap-2">
            <Keyboard aria-hidden="true" className="size-4" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Click a shortcut, then press a new key combination. Changes are saved on this device.
          </DialogDescription>
        </DialogHeader>

        <Separator />

        <div className="flex items-center gap-2 p-3">
          <div className="relative flex-1">
            <Search aria-hidden="true" className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search keyboard shortcuts"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search shortcuts…"
              className="pl-8"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetAllKeybindings()
              setBindings(getResolvedKeybindings())
              setConflict(null)
            }}
          >
            <RotateCcw data-icon="inline-start" />
            Reset all
          </Button>
        </div>

        {conflict && (
          <p role="alert" className="px-4 pb-2 text-xs text-destructive">
            {conflict} Press another shortcut or Esc to cancel.
          </p>
        )}

        <ScrollArea className="h-[min(28rem,60vh)]">
          <div className="flex flex-col gap-4 px-3 pb-4">
            {groups.map((group) => {
              const definitions = filtered.filter((definition) => definition.group === group)
              if (definitions.length === 0) return null
              return (
                <section key={group} className="flex flex-col gap-1">
                  <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">{group}</h3>
                  {definitions.map((definition) => {
                    const isRecording = recording === definition.command
                    return (
                      <div
                        key={definition.command}
                        className="flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm">{definition.label}</p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {definition.description}
                          </p>
                        </div>
                        <Button
                          variant={isRecording ? "secondary" : "outline"}
                          size="sm"
                          className="min-w-28 font-mono text-xs"
                          onClick={() => {
                            setConflict(null)
                            setRecording(isRecording ? null : definition.command)
                          }}
                          aria-label={`Change shortcut for ${definition.label}`}
                        >
                          {isRecording ? "Press keys…" : formatShortcut(bindings[definition.command])}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            resetKeybinding(definition.command)
                            setBindings(getResolvedKeybindings())
                            setConflict(null)
                          }}
                          aria-label={`Reset shortcut for ${definition.label}`}
                        >
                          <RotateCcw />
                        </Button>
                      </div>
                    )
                  })}
                </section>
              )
            })}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
