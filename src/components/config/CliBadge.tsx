import { Unlink } from "lucide-react"
import type { ConfigCli } from "./config-types"

const CLI_META: Record<ConfigCli, { letter: string; label: string }> = {
  claude: {
    letter: "C",
    label: "Loaded by Claude Code",
  },
  codex: {
    letter: "X",
    label: "Loaded by Codex CLI",
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
        className="flex shrink-0 items-center gap-1 text-xs text-warning"
        title="Present in the shared source directory but not linked into Claude or Codex"
      >
        <Unlink data-icon="inline-start" className="size-3" />
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
            className={variant === "full"
              ? "flex h-5 items-center justify-center rounded border bg-muted px-1.5 text-xs font-medium text-muted-foreground"
              : "flex size-5 items-center justify-center rounded border bg-muted text-xs font-medium text-muted-foreground"}
          >
            {variant === "full" ? name : meta.letter}
          </span>
        )
      })}
    </span>
  )
}
