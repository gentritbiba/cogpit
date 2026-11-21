import { memo } from "react"
import type { HTMLAttributes } from "react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatTokenCount } from "@/lib/format"
import { capabilitiesForDirName } from "@/lib/agents"
import type { ContextUsage } from "../../shared/session/contextWindow"
import type { SessionView } from "../../shared/session/sessionDigest"

// ── LiveIndicator ────────────────────────────────────────────────────────────

type LiveIndicatorProps = HTMLAttributes<HTMLSpanElement>

/**
 * The app's one green "live" dot — session header, dashboard cards, LIVE
 * badges. Defaults to 8px; pass a size class (`size-1.5`) to shrink it.
 */
export const LiveIndicator = memo(function LiveIndicator({
  className,
  ...rest
}: LiveIndicatorProps) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full bg-success", className)}
      {...rest}
    />
  )
})

// ── HeaderIconButton ─────────────────────────────────────────────────────────

interface HeaderIconButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
  iconClassName?: string
  size?: "sm" | "default"
}

/**
 * Icon button wrapped in a tooltip. Used for toolbar actions in headers and
 * info bars. Reduces the repetitive Tooltip > TooltipTrigger > Button >
 * TooltipContent pattern to a single component call.
 *
 * Hover is one neutral treatment for every button — colour is reserved for
 * state (active panel, destructive action), never for a button's identity.
 * `className` still wins over the default, so those cases can opt out.
 */
export const HeaderIconButton = memo(function HeaderIconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  className,
  iconClassName,
  size = "sm",
}: HeaderIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size={size === "sm" ? "icon-xs" : "icon-sm"}
            className={className}
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
          />
        }
      >
          <Icon data-icon="inline-start" className={iconClassName} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})

// ── Context pressure ─────────────────────────────────────────────────────────

type ContextPressure = "critical" | "warning" | "healthy"

/** One ladder for how much context is left, so every reading of it agrees. */
export function contextPressure(pctLeft: number): ContextPressure {
  if (pctLeft < 10) return "critical"
  if (pctLeft < 30) return "warning"
  return "healthy"
}

export const CONTEXT_STYLES: Record<ContextPressure, string> = {
  critical: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  healthy: "text-muted-foreground",
}

function ContextDetail({ ctx }: { ctx: ContextUsage }) {
  const remaining = Math.max(0, ctx.compactAt - ctx.used)
  const pctLeft = Math.max(0, 100 - ctx.percent)
  return (
    <>
      <div className="font-medium">Context before auto-compact</div>
      <div>{formatTokenCount(remaining)} remaining ({pctLeft.toFixed(1)}%)</div>
      <div className="text-muted-foreground">
        {formatTokenCount(ctx.used)} / {formatTokenCount(ctx.limit)} tokens used ({ctx.percentAbsolute.toFixed(1)}%)
      </div>
    </>
  )
}

/**
 * How full the session's context is. Usage is read out of the transcript, so
 * an agent whose records carry no token accounting has none.
 */
export function sessionContextUsage(session: SessionView, dirName: string | undefined): ContextUsage | null {
  return capabilitiesForDirName(dirName).contextWindow ? session.digest.contextUsage : null
}

// ── ContextMeter ─────────────────────────────────────────────────────────────

const METER_TEXT: Record<ContextPressure, string> = {
  critical: "text-destructive",
  warning: "text-warning",
  healthy: "text-muted-foreground",
}

const RING_RADIUS = 5.5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/**
 * How much context is left, always in view beside the model: a ring that
 * fills as the window does, and the share still free. Quiet until it runs
 * low. Renders nothing if context usage data is unavailable.
 */
export const ContextMeter = memo(function ContextMeter({ usage: ctx }: { usage: ContextUsage | null }) {
  if (!ctx) return null

  const pctLeft = Math.max(0, 100 - ctx.percent)
  const used = Math.min(1, Math.max(0, ctx.percent / 100))

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <span
            data-context-meter
            aria-label={`${pctLeft.toFixed(0)}% of context left`}
            className={cn(
              "flex shrink-0 cursor-default items-center gap-1.5 px-1.5 text-xs tabular-nums",
              METER_TEXT[contextPressure(pctLeft)],
            )}
          />
        )}
      >
        <svg viewBox="0 0 14 14" className="size-3.5 -rotate-90" aria-hidden="true">
          <circle cx="7" cy="7" r={RING_RADIUS} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
          <circle
            cx="7"
            cy="7"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - used)}
          />
        </svg>
        {pctLeft.toFixed(0)}%
      </TooltipTrigger>
      <TooltipContent side="top" className="flex flex-col gap-1 text-xs">
        <ContextDetail ctx={ctx} />
      </TooltipContent>
    </Tooltip>
  )
})
