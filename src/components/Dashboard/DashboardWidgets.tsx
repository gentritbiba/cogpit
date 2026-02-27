import { Search, X, AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent)

export function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-0.5 shrink-0">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="inline-flex items-center justify-center rounded border border-border/80 bg-muted/80 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground min-w-[20px]"
          >
            {k === "Ctrl" ? (isMac ? "\u2318" : "Ctrl") : k}
          </kbd>
        ))}
      </span>
    </div>
  )
}

export function LiveDot({ size = "md" }: { size?: "sm" | "md" }) {
  const dotSize = size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"
  return (
    <span className={cn("relative flex", dotSize)}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
      <span className={cn("relative inline-flex rounded-full bg-green-500", dotSize)} />
    </span>
  )
}

export function SearchInput({ value, onChange, placeholder }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="mb-4 relative max-w-sm">
      <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-elevation-1 pl-9 h-8 text-sm border-border/50 placeholder:text-muted-foreground"
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-red-900/50 bg-red-950/30 px-3 py-2.5">
      <AlertTriangle className="size-4 text-red-400 shrink-0" />
      <span className="text-sm text-red-400 flex-1">{message}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10"
        onClick={onRetry}
      >
        <RefreshCw className="size-3 mr-1" />
        Retry
      </Button>
    </div>
  )
}

export function SkeletonCards({ count = 3, includeMessagePlaceholder = false }: {
  count?: number
  includeMessagePlaceholder?: boolean
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-border/40 elevation-1 p-4">
          <div className="skeleton h-4 w-3/4 rounded mb-3" />
          <div className="skeleton h-3 w-1/2 rounded mb-4" />
          {includeMessagePlaceholder && <div className="skeleton h-8 w-full rounded mb-3" />}
          <div className="flex gap-3">
            <div className="skeleton h-3 w-16 rounded" />
            <div className="skeleton h-3 w-16 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** isMac constant for use by keyboard shortcuts */
export { isMac }
