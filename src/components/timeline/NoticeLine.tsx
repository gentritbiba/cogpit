import { memo } from "react"
import { AlertTriangle, Info, Lightbulb } from "lucide-react"
import { cn } from "@/lib/utils"
import type { NoticeLevel } from "../../../shared/session/types"

const LEVELS: Record<NoticeLevel, { Icon: typeof Info; icon: string; headline: string }> = {
  notice: { Icon: Info, icon: "text-muted-foreground", headline: "text-muted-foreground" },
  suggestion: { Icon: Lightbulb, icon: "text-info", headline: "text-foreground" },
  warning: { Icon: AlertTriangle, icon: "text-warning", headline: "text-foreground" },
}

/** A line the CLI showed the user mid-session, quiet unless the CLI raised its level. */
export const NoticeLine = memo(function NoticeLine({ content, level }: { content: string; level: NoticeLevel }) {
  const { Icon, icon, headline } = LEVELS[level]
  const [first, ...rest] = content.trim().split("\n")
  const detail = rest.join("\n").trim()
  return (
    <div role="note" data-level={level} className="flex items-start gap-1.5 px-1 py-0.5 text-xs text-muted-foreground">
      <Icon className={cn("mt-0.5 size-3 shrink-0", icon)} aria-hidden="true" />
      <div className="min-w-0">
        <p className={cn("whitespace-pre-wrap break-words", headline)}>{first}</p>
        {detail && <p className="mt-0.5 whitespace-pre-wrap break-words">{detail}</p>}
      </div>
    </div>
  )
})
