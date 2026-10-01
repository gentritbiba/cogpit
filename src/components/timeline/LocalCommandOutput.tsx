import { ChevronRight, Terminal } from "lucide-react"
import { parseLocalCommandOutputs, type LocalCommandOutput } from "@/lib/userMessageContent"
import { cn } from "@/lib/utils"

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
 * parsed here rather than in the session core.
 */
export function LocalCommandBlock({ content }: { content: string }) {
  const { outputs } = parseLocalCommandOutputs(content)
  if (outputs.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      {outputs.map((output, i) => (
        <LocalCommandOutputCard key={i} output={output} />
      ))}
    </div>
  )
}
