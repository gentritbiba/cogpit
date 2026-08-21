import { memo } from "react"
import type { HTMLAttributes } from "react"
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getContextUsage, formatTokenCount } from "@/lib/format"
import type { RawMessage } from "@/lib/types"

/**
 * The one surface for everything that floats over the chat pane now that
 * there is no top bar. Callers add their own height (`h-8` / `size-8`).
 */
export const FLOATING_PILL = "rounded-full border bg-background/80 shadow-sm backdrop-blur"

// ── LiveIndicator ────────────────────────────────────────────────────────────

type LiveIndicatorProps = HTMLAttributes<HTMLSpanElement>

/**
 * The app's one green "live" dot — top bar, dashboard cards, LIVE badges, the
 * composer. Defaults to 8px; pass a size class (`size-1.5`) to shrink it.
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

// ── ContextBadge ─────────────────────────────────────────────────────────────

interface ContextBadgeProps {
  rawMessages: readonly RawMessage[]
  showRemaining?: boolean
  showTooltip?: boolean
  warnOnly?: boolean
}

type ContextPressure = "critical" | "warning" | "healthy"

/** One ladder for how much context is left, so every reading of it agrees. */
function contextPressure(pctLeft: number): ContextPressure {
  if (pctLeft < 10) return "critical"
  if (pctLeft < 30) return "warning"
  return "healthy"
}

const CONTEXT_STYLES: Record<ContextPressure, string> = {
  critical: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-warning/30 bg-warning/10 text-warning",
  healthy: "text-muted-foreground",
}

/**
 * Compact badge showing context window usage percentage.
 * Renders nothing if context usage data is unavailable.
 */
export const ContextBadge = memo(function ContextBadge({
  rawMessages,
  showRemaining = false,
  showTooltip = false,
  warnOnly = false,
}: ContextBadgeProps) {
  const ctx = getContextUsage(rawMessages)
  if (!ctx) return null

  const pctLeft = Math.max(0, 100 - ctx.percent)
  const pressure = contextPressure(pctLeft)
  if (warnOnly && pressure === "healthy") return null
  const remaining = Math.max(0, ctx.compactAt - ctx.used)

  const label = showRemaining
    ? `${pctLeft.toFixed(0)}% \u00b7 ${formatTokenCount(remaining)}`
    : `${pctLeft.toFixed(0)}%`

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 tabular-nums",
        CONTEXT_STYLES[pressure],
        showRemaining && "gap-1",
      )}
    >
      {label}
    </Badge>
  )

  if (!showTooltip) return badge

  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipContent className="flex flex-col gap-1 text-xs">
        <div className="font-medium">Context before auto-compact</div>
        <div>{formatTokenCount(remaining)} remaining ({pctLeft.toFixed(1)}%)</div>
        <div className="text-muted-foreground">
          {formatTokenCount(ctx.used)} / {formatTokenCount(ctx.limit)} tokens used ({ctx.percentAbsolute.toFixed(1)}%)
        </div>
      </TooltipContent>
    </Tooltip>
  )
})
