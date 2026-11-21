import { useEffect, useState, type ReactNode } from "react"
import { ArrowUpCircle, Download, Loader2, RotateCw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useCogpitUpdate } from "@/hooks/useCogpitUpdate"
import { useProviderUpdates } from "@/hooks/useProviderUpdates"
import { can } from "@/lib/capabilities"
import type { ProviderUpdateInfo } from "@/lib/providerUpdates"
import { cn } from "@/lib/utils"

function versionChange(info: ProviderUpdateInfo): string {
  const from = info.currentVersion ? `v${info.currentVersion}` : "an older build"
  return `${from} → v${info.latestVersion}`
}

function UpdateRow({ title, detail, tone, children }: {
  title: string
  detail?: string
  tone?: "destructive"
  children?: ReactNode
}) {
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-sm font-medium", tone === "destructive" && "text-destructive")}>{title}</span>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </div>
      {children && <div className="flex items-center gap-1.5">{children}</div>}
    </li>
  )
}

interface UpdatesMenuProps {
  /** Which way the list opens from its button. */
  side?: "left" | "bottom"
  className?: string
}

/**
 * Every update the app knows about behind one button: an installed Cogpit
 * waiting for a restart, and agent CLIs that are behind their release. With
 * nothing to do there is no button.
 *
 * The CLIs belong to the host, so only someone who may change its config is
 * offered their updates.
 */
export function UpdatesMenu({ side = "left", className }: UpdatesMenuProps) {
  const { update: cogpit, restarting, install } = useCogpitUpdate()
  const { pending, updating, outcome, update, dismiss, clearOutcome } = useProviderUpdates()
  const [open, setOpen] = useState(false)
  const providers = can("configWrite") ? pending : []
  const failure = outcome?.status === "failed" ? outcome : null

  useEffect(() => {
    if (outcome?.status !== "succeeded") return
    toast.success(outcome.message, { description: "New sessions will use the updated CLI." })
    clearOutcome()
  }, [outcome, clearOutcome])

  const cogpitWaiting = cogpit.status === "ready" || cogpit.status === "failed"
  const count = providers.length + (cogpitWaiting ? 1 : 0) + (failure ? 1 : 0)
  if (count === 0) return null

  const urgent = cogpit.status === "failed" || failure !== null
  const label = count === 1 ? "1 update" : `${count} updates`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            className={cn("relative rounded-md data-popup-open:bg-accent", className)}
          />
        )}
      >
        {updating ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <ArrowUpCircle data-icon="inline-start" />}
        <span
          aria-hidden
          className={cn("absolute right-1 top-1 size-1.5 rounded-full", urgent ? "bg-destructive" : "bg-info")}
        />
      </PopoverTrigger>
      <PopoverContent side={side} align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Updates
        </div>
        <ul className="flex flex-col divide-y">
          {cogpit.status === "ready" && (
            <UpdateRow
              title={`Cogpit v${cogpit.version} is ready`}
              detail={cogpit.asksForPassword
                ? "Restart and enter your password to install it."
                : "Restart to finish updating, or it installs the next time you quit."}
            >
              <Button variant="outline" size="xs" disabled={restarting} onClick={install}>
                <RotateCw data-icon="inline-start" />
                Restart now
              </Button>
            </UpdateRow>
          )}

          {cogpit.status === "failed" && (
            <UpdateRow
              tone="destructive"
              title={`Cogpit v${cogpit.version} could not be installed`}
              detail={cogpit.message}
            >
              <Button
                variant="outline"
                size="xs"
                render={<a href={cogpit.url} target="_blank" rel="noopener noreferrer" />}
                nativeButton={false}
              >
                <Download data-icon="inline-start" />
                Download
              </Button>
            </UpdateRow>
          )}

          {failure && (
            <UpdateRow tone="destructive" title="Update did not complete" detail={failure.message}>
              <Button variant="ghost" size="xs" onClick={clearOutcome}>Dismiss</Button>
            </UpdateRow>
          )}

          {providers.map((info) => (
            <UpdateRow
              key={info.provider}
              title={`${info.displayName} ${versionChange(info)}`}
              detail={info.updateCommand
                ? `Cogpit can run \`${info.updateCommand}\` for you.`
                : "Update it with whatever installed it. Cogpit could not tell."}
            >
              {info.updateCommand && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={updating !== null}
                  onClick={() => void update(info.provider)}
                  aria-label={`Update ${info.displayName}`}
                >
                  <ArrowUpCircle data-icon="inline-start" />
                  {updating === info.provider ? "Updating…" : "Update"}
                </Button>
              )}
              <Button
                variant="ghost"
                size="xs"
                disabled={updating !== null}
                onClick={() => dismiss(info)}
                aria-label={`Skip this ${info.displayName} version`}
                className="text-muted-foreground"
              >
                Skip this version
              </Button>
            </UpdateRow>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
