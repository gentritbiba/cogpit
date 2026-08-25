import { useEffect, useState } from "react"
import { Check, Copy, RefreshCw, Share2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAppContext } from "@/contexts/AppContext"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { sharePathFor, useShares } from "@/hooks/useShare"
import { cn } from "@/lib/utils"

/** How often the open popover re-reads the guest count. */
const GUEST_POLL_MS = 5000

const MASKED = "••••"

interface ShareButtonProps {
  sessionId: string
}

function guestLabel(guests: number): string {
  if (guests === 0) return "No guests connected"
  return guests === 1 ? "1 guest connected" : `${guests} guests connected`
}

/**
 * Enable, inspect and revoke the share on the open session.
 *
 * The trigger is deliberately loud once a share exists: a forgotten share is an
 * open door onto the host machine, so it has to be visible without opening
 * anything. The plaintext passphrase lives in this component's state and
 * nowhere else — the server hands it over exactly once, at mint or rotate.
 */
export function ShareButton({ sessionId }: ShareButtonProps) {
  const { config: { networkAccessDisabled } } = useAppContext()
  const { shares, error, refresh, create, regenerate, revoke } = useShares()
  const [open, setOpen] = useState(false)
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [linkCopied, copyLink] = useCopyWithFeedback()
  const [bothCopied, copyBoth] = useCopyWithFeedback()

  const share = shares.find((candidate) => candidate.sessionId === sessionId) ?? null
  const url = `${window.location.origin}${sharePathFor(sessionId)}`

  // A different session is a different share; the old passphrase must not
  // linger on screen next to the new session's link.
  useEffect(() => setPassphrase(null), [sessionId])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = setInterval(() => void refresh(), GUEST_POLL_MS)
    return () => clearInterval(timer)
  }, [open, refresh])

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const localOnlyNote = networkAccessDisabled && (
    <p className="text-xs text-muted-foreground">
      Network access is off, so this link only works on this machine.
    </p>
  )

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Closing spends the one showing the server ever gives us. Reopening
        // has to fall back to Regenerate rather than re-reveal it.
        if (!next) setPassphrase(null)
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={share ? "Session is shared" : "Share session"}
            className={cn(share && "bg-primary/15 text-primary hover:bg-primary/25")}
          />
        }
      >
        <Share2 data-icon="inline-start" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="w-80 p-3">
        {share ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
                {url}
              </code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copy link"
                onClick={() => copyLink(url)}
              >
                {linkCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
              </Button>
            </div>

            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
                {passphrase ?? MASKED}
              </code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Regenerate passphrase"
                disabled={busy}
                onClick={() => run(async () => {
                  setPassphrase(await regenerate(sessionId))
                })}
              >
                <RefreshCw data-icon="inline-start" />
              </Button>
            </div>

            {passphrase ? (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => copyBoth(`${url}\nPassphrase: ${passphrase}`)}
              >
                {bothCopied ? "Copied" : "Copy link & passphrase"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                The passphrase is only shown once. Regenerate to get a new one.
              </p>
            )}

            {localOnlyNote}
            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex items-center justify-between gap-2 border-t pt-2">
              <span className="text-xs text-muted-foreground">{guestLabel(share.guests)}</span>
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive hover:text-destructive"
                disabled={busy}
                onClick={() => run(async () => {
                  await revoke(sessionId)
                  setPassphrase(null)
                })}
              >
                Stop sharing
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-xs text-muted-foreground">
              Anyone with the link and passphrase can read and join this session.
            </p>
            {localOnlyNote}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button
              size="xs"
              disabled={busy}
              onClick={() => run(async () => {
                setPassphrase(await create(sessionId))
              })}
            >
              Enable sharing
            </Button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
