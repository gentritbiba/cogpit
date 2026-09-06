import { useCallback, useEffect, useState } from "react"
import { Check, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/Spinner"
import { ALL_SKILL_TARGETS } from "@/hooks/useBrowserSessions"
import type { SkillInstallResult, SkillTarget, SkillTargetsResult } from "@/hooks/useBrowserSessions"
import type { BrowserSkillTarget } from "../../../shared/browser/types"

/**
 * Where the browser skill is installed, and the only place it gets installed
 * from. Every row writes into the user's own home directory, so the dialog
 * names the directory before the button and nothing here happens on its own.
 */

interface BrowserSkillDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  readTargets: () => Promise<SkillTargetsResult>
  install: (target: SkillTarget) => Promise<SkillInstallResult>
}

export function BrowserSkillDialog({
  open,
  onOpenChange,
  readTargets,
  install,
}: BrowserSkillDialogProps) {
  const [targets, setTargets] = useState<BrowserSkillTarget[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<SkillTarget | null>(null)

  const load = useCallback(async () => {
    const result = await readTargets()
    if (result.ok) {
      setTargets(result.targets)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [readTargets])

  useEffect(() => {
    if (!open) return
    setError(null)
    void load()
  }, [open, load])

  async function run(target: SkillTarget): Promise<void> {
    setPending(target)
    const result = await install(target)
    setPending(null)
    if (result.ok) await load()
    else setError(result.error)
  }

  const missing = targets?.some((target) => !target.installed) ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Agent skill</DialogTitle>
          <DialogDescription>
            The skill teaches an agent how Cogpit&rsquo;s browsers work: when to use a named
            one, when to keep to a throwaway, and that this panel is watching. Install it for
            agents you run outside Cogpit &mdash; it writes a{" "}
            <code className="font-mono">SKILL.md</code> into that CLI&rsquo;s configuration
            directory in your home folder.
          </DialogDescription>
        </DialogHeader>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        {targets === null
          ? (
            <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Spinner />
              Reading where it is installed…
            </div>
          )
          : (
            <ul className="flex flex-col gap-2">
              {targets.map((target) => (
                <li key={target.kind} className="flex items-center gap-3 rounded-md border p-2.5">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{target.label}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {target.configRoot}
                    </span>
                    {target.automatic && (
                      <span className="truncate text-xs text-muted-foreground">
                        Already automatic in the sessions Cogpit starts
                      </span>
                    )}
                  </span>
                  {target.installed
                    ? (
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <Check aria-hidden className="size-3.5 text-emerald-500" />
                        Installed
                      </span>
                    )
                    : (
                      <Button
                        size="xs"
                        variant="outline"
                        aria-label={`Install for ${target.label}`}
                        disabled={pending !== null}
                        onClick={() => void run(target.kind)}
                      >
                        Install
                      </Button>
                    )}
                </li>
              ))}
            </ul>
          )}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={!missing || pending !== null}
            onClick={() => void run(ALL_SKILL_TARGETS)}
          >
            <Sparkles data-icon="inline-start" />
            Install for all
          </Button>
          <DialogClose render={<Button type="button" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
