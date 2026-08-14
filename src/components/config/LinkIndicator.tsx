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
        "flex items-center gap-1 text-sky-400/70 shrink-0 min-w-0",
        className,
      )}
      title={`Symlink → ${linkTarget}`}
    >
      <Link2 className="size-2.5 shrink-0" />
      {variant === "full" && (
        <span className="text-[10px] font-mono truncate">→ {linkTarget}</span>
      )}
    </span>
  )
}
