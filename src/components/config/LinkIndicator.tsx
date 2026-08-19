import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface LinkIndicatorProps {
  /** Canonical path this entry resolves to; absent when the file is not a symlink. */
  linkTarget?: string
  /** "full" shows the target path inline; "compact" is icon-only for list rows. */
  variant?: "compact" | "full"
  className?: string
}

/** Marks an entry that is a symlink, and says where it actually points. */
export function LinkIndicator({ linkTarget, variant = "compact", className }: LinkIndicatorProps) {
  if (!linkTarget) return null

  return (
    <span
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1 text-info",
        className,
      )}
      title={`Symlink → ${linkTarget}`}
    >
      <Link2 data-icon="inline-start" className="size-3 shrink-0" />
      {variant === "full" && (
        <span className="truncate font-mono text-xs">→ {linkTarget}</span>
      )}
    </span>
  )
}
