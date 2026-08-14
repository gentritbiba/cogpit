import { Unlink } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ConfigCli } from "./config-types"

const CLI_META: Record<ConfigCli, { letter: string; label: string; className: string }> = {
  claude: {
    letter: "C",
    label: "Loaded by Claude Code",
    className: "bg-orange-500/15 text-orange-300/90 border-orange-500/25",
  },
  codex: {
    letter: "X",
    label: "Loaded by Codex CLI",
    className: "bg-teal-500/15 text-teal-300/90 border-teal-500/25",
  },
}

interface CliBadgeProps {
  cli?: ConfigCli[]
  /** "full" spells the CLI names out; "compact" uses single letters for list rows. */
  variant?: "compact" | "full"
}

/**
 * Shows which CLIs can load an entry. An entry found only in a shared source
 * directory is loaded by neither, which is worth flagging rather than hiding.
 */
export function CliBadge({ cli, variant = "compact" }: CliBadgeProps) {
  if (!cli) return null

  if (cli.length === 0) {
    return (
      <span
        className="flex items-center gap-0.5 text-[9px] text-amber-400/70 shrink-0"
        title="Present in the shared source directory but not linked into Claude or Codex"
      >
        <Unlink className="size-2.5" />
        {variant === "full" && "unlinked"}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-0.5 shrink-0">
      {cli.map((name) => {
        const meta = CLI_META[name]
        return (
          <span
            key={name}
            title={meta.label}
            className={cn(
              "flex items-center justify-center rounded-sm border font-medium",
              meta.className,
              variant === "full" ? "px-1 h-4 text-[9px]" : "size-3.5 text-[8px]",
            )}
          >
            {variant === "full" ? name : meta.letter}
          </span>
        )
      })}
    </span>
  )
}
