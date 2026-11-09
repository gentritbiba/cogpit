import { memo } from "react"
import { ChevronRight, Terminal } from "lucide-react"
import { parseLocalCommandOutputs, type LocalCommandOutput } from "@/lib/userMessageContent"
import { readableContextUsage, readableUsageLimits } from "@/lib/localCommandReports"
import { cn } from "@/lib/utils"
import type { LocalCommandContextUsage, LocalCommandUsageReport } from "../../../shared/session/types"
import { ContextUsageCard, UsageReportCard } from "./LocalCommandReports"

export function LocalCommandOutputCard({ output }: { output: LocalCommandOutput }) {
  const isError = output.stream === "stderr"
  const isInput = output.stream === "input"
  return (
    <div className={cn(
      "rounded-md border px-3 py-2 my-1 font-mono text-xs",
      isError && "border-destructive/20 bg-destructive/5 text-destructive",
      isInput && "border-border bg-muted/50 text-foreground",
      !isError && !isInput && "border-border bg-muted/40 text-muted-foreground",
    )}>
      <div className="flex items-start gap-1.5">
        {isInput ? (
          <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" data-icon="inline-start" />
        ) : (
          <Terminal className={cn("mt-0.5 size-3 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} data-icon="inline-start" />
        )}
        <span className="whitespace-pre-wrap break-words">{output.text}</span>
      </div>
    </div>
  )
}

/**
 * The `local_command` content block: what a locally run slash command printed
 * for the user. The block carries the record verbatim, so the grammar is
 * parsed here rather than in the session core. A `/context` or `/usage` reply
 * that recorded its structured twin draws as a card; older records keep the
 * text.
 */
export const LocalCommandBlock = memo(function LocalCommandBlock({ content, contextUsage, usageReport }: {
  content: string
  contextUsage?: LocalCommandContextUsage
  usageReport?: LocalCommandUsageReport
}) {
  const context = readableContextUsage(contextUsage)
  if (context) return <ContextUsageCard usage={context} />
  const { outputs } = parseLocalCommandOutputs(content)
  const limits = readableUsageLimits(usageReport)
  if (usageReport && limits) {
    const text = outputs.filter((output) => output.stream === "stdout").map((output) => output.text).join("\n\n")
    return <UsageReportCard report={usageReport} limits={limits} text={text} />
  }
  if (outputs.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      {outputs.map((output, i) => (
        <LocalCommandOutputCard key={i} output={output} />
      ))}
    </div>
  )
})
