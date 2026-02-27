import { memo } from "react"
import type { ReactNode, HTMLAttributes } from "react"
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

/** Pulsing green dot that indicates a live session. */
export const LiveIndicator = memo(function LiveIndicator({
  className,
  ...rest
}: LiveIndicatorProps) {
  return (
    <span className={cn("relative flex h-2 w-2 shrink-0", className)} {...rest}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
    </span>
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
  const sizeClass = size === "sm" ? "h-7 w-7 p-0" : "h-8 w-8 p-0"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(sizeClass, className)}
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          <Icon className={cn("size-3.5", iconClassName)} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})

// ── HeaderActionButton ───────────────────────────────────────────────────────

interface HeaderActionButtonProps {
  icon: ReactNode
  label: string
  tooltip: string
  onClick: () => void
  disabled?: boolean
  className?: string
}

/**
 * Labeled action button with tooltip, used in SessionInfoBar for actions
 * like "New", "Duplicate", "Open", etc.
 */
export const HeaderActionButton = memo(function HeaderActionButton({
  icon,
  label,
  tooltip,
  onClick,
  disabled,
  className,
}: HeaderActionButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-6 px-2 gap-1.5 text-[11px]", className)}
          onClick={onClick}
          disabled={disabled}
        >
          {icon}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
})

// ── ContextBadge ─────────────────────────────────────────────────────────────

interface ContextBadgeProps {
  rawMessages: readonly RawMessage[]
  showRemaining?: boolean
  showTooltip?: boolean
}

function getContextColors(pctLeft: number): {
  border: string
  text: string
  bg: string
} {
  if (pctLeft < 10) {
    return { border: "border-red-700/60", text: "text-red-400", bg: "bg-red-500/5" }
  }
  if (pctLeft < 30) {
    return { border: "border-amber-700/60", text: "text-amber-400", bg: "bg-amber-500/5" }
  }
  return { border: "border-green-700/60", text: "text-green-400", bg: "bg-green-500/5" }
}

/**
 * Compact badge showing context window usage percentage.
 * Renders nothing if context usage data is unavailable.
 */
export const ContextBadge = memo(function ContextBadge({
  rawMessages,
  showRemaining = false,
  showTooltip = false,
}: ContextBadgeProps) {
  const ctx = getContextUsage(rawMessages)
  if (!ctx) return null

  const pctLeft = Math.max(0, 100 - ctx.percent)
  const remaining = Math.max(0, ctx.compactAt - ctx.used)
  const colors = getContextColors(pctLeft)

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
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
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
