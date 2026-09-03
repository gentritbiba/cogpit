import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

interface FilterChipProps extends Omit<ComponentProps<"button">, "type"> {
  pressed: boolean
}

export function FilterChip({ pressed, className, children, ...props }: FilterChipProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] leading-none outline-none transition-colors",
        "focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:opacity-40",
        pressed
          ? "border-foreground/20 bg-foreground/[0.06] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export function FilterChipCount({ children }: { children: ComponentProps<"span">["children"] }) {
  return <span className="font-mono text-[10px] tabular-nums opacity-70">{children}</span>
}
