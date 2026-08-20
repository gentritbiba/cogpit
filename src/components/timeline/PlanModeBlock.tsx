import { memo, useEffect, useRef, useState } from "react"
import { ChevronRight, ChevronDown, NotebookPen, CheckCircle, Clock, XCircle } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ToolCall } from "@/lib/types"
import type { SkillMeta } from "@/hooks/useSkillMetadata"
import { ToolCallCard } from "./ToolCallCard"
import { markdownComponents } from "./markdown-components"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

interface Props {
  plan: string
  planFilePath?: string
  status: "pending" | "approved" | "rejected"
  toolCalls: ToolCall[]
  expandAll?: boolean
  expandToolPayloads?: boolean
  isAgentActive?: boolean
  skillMetadata?: Map<string, SkillMeta>
}

export const PlanModeBlock = memo(function PlanModeBlock({
  plan,
  planFilePath,
  status,
  toolCalls,
  expandAll = false,
  expandToolPayloads = false,
  isAgentActive,
  skillMetadata,
}: Props) {
  const [open, setOpen] = useState(true)
  const hasPendingQuestion = toolCalls.some(
    (tc) => tc.name === "AskUserQuestion" && tc.result === null,
  )
  // An unanswered question inside a collapsed plan block is unreachable, so it
  // forces the list open. Latched: once opened it stays open, so the list does
  // not collapse out from under the user the moment they answer. An explicit
  // toggle always wins.
  const [callsOverride, setCallsOverride] = useState<boolean | null>(null)
  const autoOpened = useRef(hasPendingQuestion)
  useEffect(() => {
    if (hasPendingQuestion) autoOpened.current = true
  }, [hasPendingQuestion])
  const planOpen = expandAll || open
  const callsOpen = expandAll || (callsOverride ?? (hasPendingQuestion || autoOpened.current))

  const Icon = status === "approved" ? CheckCircle : status === "rejected" ? XCircle : Clock
  const Chev = planOpen ? ChevronDown : ChevronRight
  const CallsChev = callsOpen ? ChevronDown : ChevronRight

  return (
    <Collapsible
      open={planOpen}
      onOpenChange={setOpen}
      className={cn(
        "my-2 rounded-lg border",
        status === "approved"
          ? "border-success/20 bg-success/5"
          : status === "rejected"
            ? "border-destructive/20 bg-destructive/5"
            : "border-warning/20 bg-warning/5",
      )}
    >
      <CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto w-full justify-start rounded-b-none p-2 text-left" />}>
        <Chev className="size-3.5 shrink-0 text-muted-foreground" data-icon="inline-start" />
        <NotebookPen className="size-4 text-muted-foreground" data-icon="inline-start" />
        <span className="text-sm font-medium">Plan Mode</span>
        <Icon
          className={cn(
            "size-4",
            status === "approved"
              ? "text-success"
              : status === "rejected"
                ? "text-destructive"
                : "text-warning",
          )}
        />
        <span className="text-xs text-muted-foreground capitalize">{status}</span>
        {planFilePath && (
          <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
            {planFilePath}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-3 pb-2">
          <div className="prose prose-sm dark:prose-invert max-w-none border-t pt-2">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {plan}
            </ReactMarkdown>
          </div>

          {toolCalls.length > 0 && (
            <Collapsible open={callsOpen} onOpenChange={setCallsOverride} className="mt-2">
              <CollapsibleTrigger render={<Button type="button" variant="ghost" size="xs" className="-ml-2 text-muted-foreground" />}>
                <CallsChev data-icon="inline-start" />
                {toolCalls.length} call{toolCalls.length === 1 ? "" : "s"} during planning
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-4 mt-1 flex flex-col gap-1">
                  {toolCalls.map((tc) => (
                    <ToolCallCard
                      key={tc.id}
                      toolCall={tc}
                      expandAll={expandAll}
                      expandToolPayloads={expandToolPayloads}
                      isAgentActive={isAgentActive}
                      skillMetadata={skillMetadata}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
