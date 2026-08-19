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
      className={cn("inline-block size-2 shrink-0 rounded-full bg-green-500", className)}
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
  const sizeClass = size === "sm" ? "h-6 w-6 p-0" : "h-7 w-7 p-0"
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="sm" className={cn(sizeClass, "text-muted-foreground hover:text-foreground", className)} onClick={onClick} disabled={disabled} aria-label={label} />}>
          <Icon className={cn("size-3.5", iconClassName)} />
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

const CONTEXT_COLORS: Record<ContextPressure, { border: string; text: string; bg: string }> = {
  critical: { border: "border-red-700/60", text: "text-red-400", bg: "bg-red-500/5" },
  warning: { border: "border-amber-700/60", text: "text-amber-400", bg: "bg-amber-500/5" },
  healthy: { border: "border-green-700/60", text: "text-green-400", bg: "bg-green-500/5" },
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
  const colors = CONTEXT_COLORS[pressure]

  const label = showRemaining
    ? `${pctLeft.toFixed(0)}% \u00b7 ${formatTokenCount(remaining)}`
    : `${pctLeft.toFixed(0)}%`

  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[10px] font-semibold shrink-0",
        colors.border,
        colors.text,
        colors.bg,
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
      <TooltipContent className="text-xs space-y-1">
        <div className="font-medium">Context Left Until Auto-Compact</div>
        <div>{formatTokenCount(remaining)} remaining ({pctLeft.toFixed(1)}%)</div>
        <div className="text-muted-foreground">
          {formatTokenCount(ctx.used)} / {formatTokenCount(ctx.limit)} tokens used ({ctx.percentAbsolute.toFixed(1)}%)
        </div>
      </TooltipContent>
    </Tooltip>
  )
})
