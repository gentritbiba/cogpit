import { useId, useMemo, useState } from "react"
import { Check, ChevronRight, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { cn } from "@/lib/utils"
import { getCodexExecCalls } from "../../../shared/session/codex-exec"
import { getCommandText, getToolPresentation } from "../../../shared/session/toolSummary"
import { ToolCallInput } from "./ToolCallInput"
import { ToolCodeHighlighted } from "./ToolCallResult"

function NestedCall({ name, input }: { name: string; input: Record<string, unknown> }): React.ReactElement {
  const presentation = getToolPresentation(typeof input.raw === "string" && input.raw.startsWith("{")
    ? { name: "exec", input: { raw: `tools.${name}(${input.raw})` } }
    : { name, input })
  const command = getCommandText(input)
  const fields = command
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "command" && key !== "cmd"))
    : input
  return (
    <section className="min-w-0" aria-label={presentation.label}>
      <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
        <span className="font-medium">{presentation.label}</span>
        {presentation.summary && !command && <span className="truncate text-muted-foreground">{presentation.summary}</span>}
      </div>
      {command && <ToolCodeHighlighted code={command} language="bash" label="Command" />}
      <ToolCallInput input={fields} />
    </section>
  )
}

export function CodexExecToolInput({ input }: { input: Record<string, unknown> }): React.ReactElement {
  const script = String(input.raw ?? "")
  const calls = useMemo(() => getCodexExecCalls(input), [input])
  const [sourceOpen, setSourceOpen] = useState(false)
  const [copied, copyScript] = useCopyWithFeedback()
  const sourceId = useId()
  const showSource = calls.length === 0 || sourceOpen

  return (
    <section className="mt-2 min-w-0" aria-label="Tool script">
      {calls.length > 0 && (
        <div className="flex min-w-0 flex-col gap-3">
          {calls.map((call, index) => <NestedCall key={index} {...call} />)}
        </div>
      )}
      <div className="mb-1 mt-1 flex items-center justify-between gap-2">
        {calls.length > 0 ? (
          <Button type="button" variant="ghost" size="xs" aria-expanded={showSource} aria-controls={sourceId} onClick={() => setSourceOpen((open) => !open)}>
            <ChevronRight data-icon="inline-start" className={cn(showSource && "rotate-90")} />
            Source
          </Button>
        ) : <span className="text-xs text-muted-foreground">Script</span>}
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => copyScript(script)} aria-label={copied ? "Tool script copied" : "Copy script"}>
          {copied ? <Check data-icon="icon" /> : <Copy data-icon="icon" />}
        </Button>
      </div>
      <Collapsible open={showSource}>
        <CollapsibleContent id={sourceId}>
          <ToolCodeHighlighted code={script} language="typescript" label="Codex exec script" />
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
