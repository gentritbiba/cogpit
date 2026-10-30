import type { ReactNode } from "react"
import { Clock } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { descriptorForDirName } from "../../shared/session/agent-descriptors"
import type { RateLimitBlock } from "../../shared/session/rateLimit"
import { getResumeCommand, sessionIdFromFileName } from "@/lib/agents"
import { isRemoteDeviceActive } from "@/lib/device"
import { openProjectTerminal } from "@/lib/openTerminal"

interface RateLimitBannerProps {
  children?: ReactNode
  block: RateLimitBlock
  dirName: string
  fileName: string
  cwd: string | null
  /** The user may open a terminal here and drive this session. */
  terminal: boolean
}

/** How the runtime's own name for an allowance reads in a sentence. */
const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "spend",
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

function limitLabel(limit: string | null): string {
  return (limit && LIMIT_LABELS[limit]) ?? "usage"
}

/** Absolute rather than relative, so the line does not go stale between renders. */
function resetText(resetsAt: number | null): string | null {
  if (resetsAt === null) return null
  const reset = new Date(resetsAt * 1000)
  if (Number.isNaN(reset.getTime())) return null
  const distant = reset.getTime() - Date.now() > ONE_DAY_MS
  return reset.toLocaleString(undefined, {
    ...(distant ? { weekday: "short" } : {}),
    hour: "numeric",
    minute: "2-digit",
  })
}

/** What the runtime said about the account's extra usage, as a sentence; empty when it said nothing. */
function extraUsageText(extraUsage: boolean | undefined): string {
  if (extraUsage === undefined) return ""
  return extraUsage ? "Extra usage is on but did not cover this. " : "Extra usage is off for this account. "
}

/** The provider block, terminal handoff and optional recovery controls. */
export function RateLimitBanner({ block, dirName, fileName, cwd, terminal, children }: RateLimitBannerProps) {
  const descriptor = descriptorForDirName(dirName)
  const command = getResumeCommand(descriptor.kind, sessionIdFromFileName(fileName), cwd ?? undefined)
  const reset = resetText(block.resetsAt)
  const lowPriority = block.lowPriority && descriptor.capabilities.lowPriorityInTerminal
  const canOpenTerminal = lowPriority && terminal && !isRemoteDeviceActive()

  return (
    <Alert role="status" className="rounded-none border-x-0 border-t-0 px-4 py-2">
      <Clock />
      <AlertTitle>
        {descriptor.displayName} hit its {limitLabel(block.limit)} limit
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>
          {reset ? `Resets at ${reset}. ` : ""}
          {extraUsageText(block.extraUsage)}
          {lowPriority ? (
            <>
              It can keep this session going before then at lower priority, spending your
              weekly allowance to do it — a mode that exists only in its own terminal.
              Resume there with <code className="font-mono">{command}</code>.
            </>
          ) : (
            <>The allowance must refill before this session can continue.</>
          )}
        </span>
        {children}
        {canOpenTerminal && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => openProjectTerminal({ path: cwd ?? undefined, dirName, command })}
          >
            Open in terminal
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
