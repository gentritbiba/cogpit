import { useEffect } from "react"
import { AlertTriangle, ArrowUpCircle, CheckCircle, Loader2, XCircle } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useProviderUpdates } from "@/hooks/useProviderUpdates"
import { can } from "@/lib/capabilities"
import type { ProviderUpdateInfo } from "@/lib/providerUpdates"

const SUCCESS_VISIBLE_MS = 5_000

const TONE_CLASSES = {
  warning: "border-warning/30 bg-warning/10 text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  success: "border-success/30 bg-success/10 text-success",
} as const

function bannerClasses(tone: keyof typeof TONE_CLASSES): string {
  return `grid-cols-[auto_minmax(0,1fr)_auto] rounded-none border-x-0 border-t-0 px-4 py-2 ${TONE_CLASSES[tone]}`
}

function describe(info: ProviderUpdateInfo): string {
  const from = info.currentVersion ? `v${info.currentVersion}` : "an older build"
  return `${info.displayName} ${from} → v${info.latestVersion}`
}

/**
 * Prompts when an installed agent CLI is behind its published release.
 *
 * Runs the upgrade in place when Cogpit recognised how the binary was
 * installed; otherwise it shows the command so the user can run it themselves.
 */
export function ProviderUpdateBanner() {
  const { pending, updating, outcome, update, dismiss, clearOutcome } = useProviderUpdates()
  const canRunUpdates = can("configWrite")
  const succeeded = outcome?.status === "succeeded"

  useEffect(() => {
    if (!succeeded) return
    const timer = setTimeout(clearOutcome, SUCCESS_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [succeeded, clearOutcome])

  if (outcome) {
    return succeeded ? (
      <Alert className={bannerClasses("success")}>
        <CheckCircle />
        <AlertTitle>{outcome.message}</AlertTitle>
        <AlertDescription className="text-success/80">
          New sessions will use the updated CLI.
        </AlertDescription>
      </Alert>
    ) : (
      <Alert className={bannerClasses("destructive")}>
        <XCircle />
        <AlertTitle>Update did not complete</AlertTitle>
        <AlertDescription className="text-destructive/80">{outcome.message}</AlertDescription>
        <AlertAction className="static col-start-3 row-span-2 row-start-1 self-center">
          <Button variant="ghost" size="xs" onClick={clearOutcome}>
            Dismiss
          </Button>
        </AlertAction>
      </Alert>
    )
  }

  if (pending.length === 0) return null

  const first = pending[0]
  const runnable = pending.filter((info) => info.updateCommand !== null && canRunUpdates)

  return (
    <Alert className={bannerClasses("warning")}>
      {updating ? <Loader2 className="animate-spin" /> : <AlertTriangle />}
      <AlertTitle>
        {pending.length === 1
          ? describe(first)
          : `${pending.map((info) => info.displayName).join(" and ")} are out of date`}
      </AlertTitle>
      <AlertDescription className="text-warning/80">
        {pending.length > 1
          ? pending.map(describe).join(" · ")
          : runnable.length === 1
            ? `Cogpit can run \`${first.updateCommand}\` for you.`
            : first.updateCommand
              ? `Run \`${first.updateCommand}\` to upgrade.`
              : "Update it with whatever installed it — Cogpit could not tell."}
      </AlertDescription>
      <AlertAction className="static col-start-3 row-span-2 row-start-1 flex items-center gap-2 self-center">
        {runnable.map((info) => (
          <Button
            key={info.provider}
            variant="outline"
            size="xs"
            disabled={updating !== null}
            onClick={() => void update(info.provider)}
          >
            <ArrowUpCircle data-icon="inline-start" />
            {updating === info.provider
              ? "Updating…"
              : pending.length === 1
                ? "Update"
                : `Update ${info.displayName}`}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="xs"
          disabled={updating !== null}
          onClick={() => pending.forEach(dismiss)}
          className="whitespace-nowrap text-muted-foreground"
        >
          Don't show again
        </Button>
      </AlertAction>
    </Alert>
  )
}
