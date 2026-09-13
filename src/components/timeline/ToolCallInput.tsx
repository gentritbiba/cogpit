import { useId, useState } from "react"
import { Check, Circle, CircleDot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { readableToolText } from "../../../shared/session/toolSummary"

const FIELD_LABELS: Record<string, string> = {
  file_path: "File", path: "Path", target: "Recipient", recipient: "Recipient",
  recipient_agent_id: "Recipient", agent_id: "Agent", agent_type: "Agent type",
  subagent_type: "Agent type", task_name: "Task", description: "Description",
  message: "Message", prompt: "Task", content: "Content", query: "Query",
  pattern: "Pattern", url: "URL", workdir: "Working directory", cwd: "Working directory",
  max_output_tokens: "Output limit", yield_time_ms: "Yield", timeout_ms: "Timeout",
}

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase())
}

function fieldValue(key: string, value: unknown): string {
  if (typeof value === "number") {
    if (key === "max_output_tokens") return `${value.toLocaleString()} tokens`
    if (key.endsWith("_ms")) return value < 1000 ? `${value} ms` : `${value / 1000} sec`
  }
  return String(value)
}

function InputText({ value }: { value: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const readable = readableToolText(value)
  const long = readable.length > 800
  return (
    <>
      <div id={id} className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere]", expanded && "max-h-96 overflow-auto")}>
        {long && !expanded ? `${readable.slice(0, 800)}…` : readable}
      </div>
      {long && (
        <Button type="button" variant="ghost" size="xs" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((open) => !open)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </>
  )
}

interface PlanStep { text: string; status: string }

function planSteps(input: Record<string, unknown>): PlanStep[] {
  const values = input.todos ?? input.plan
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return []
    const item = value as Record<string, unknown>
    const text = item.content ?? item.step ?? item.description
    return typeof text === "string" ? [{ text, status: typeof item.status === "string" ? item.status : "pending" }] : []
  })
}

function PlanInput({ steps }: { steps: PlanStep[] }): React.ReactElement {
  return (
    <section className="mt-2 min-w-0" aria-label="Plan">
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => {
          const complete = step.status === "completed"
          const active = step.status === "in_progress"
          const Icon = complete ? Check : active ? CircleDot : Circle
          const label = complete ? "Completed" : active ? "In progress" : "Pending"
          return (
            <li key={index} className="flex min-w-0 items-start gap-2 text-xs">
              <Icon role="img" aria-label={label} className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground", active && "text-info")} />
              <div className="min-w-0 flex-1"><InputText value={step.text} /></div>
              <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function QuestionInput({ questions }: { questions: Record<string, unknown>[] }): React.ReactElement {
  return (
    <section className="mt-2 flex min-w-0 flex-col gap-3" aria-label="Questions">
      {questions.map((question, index) => (
        <div key={index} className="min-w-0 text-xs">
          <InputText value={String(question.question ?? question.title)} />
          {Array.isArray(question.options) && (
            <ul className="mt-2 flex min-w-0 flex-col gap-1.5 border-l border-border pl-3">
              {question.options.map((option, optionIndex) => {
                const item = typeof option === "string" ? { label: option } : option as { label?: unknown; description?: unknown } | null
                if (!item || typeof item.label !== "string") return null
                return (
                  <li key={optionIndex} className="min-w-0">
                    <InputText value={item.label} />
                    {typeof item.description === "string" && (
                      <div className="mt-0.5 text-muted-foreground"><InputText value={item.description} /></div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ))}
    </section>
  )
}

export function ToolCallInput({ input }: { input: Record<string, unknown> }): React.ReactElement | null {
  const steps = planSteps(input)
  const questions = Array.isArray(input.questions)
    ? input.questions.filter((question): question is Record<string, unknown> =>
      question !== null && typeof question === "object" &&
      typeof (question.question ?? question.title) === "string")
    : []
  const fields = Object.entries(input).filter(([key, value]) =>
    key !== "raw" && key !== "type" &&
    (typeof value === "string" ? value.length > 0 : typeof value === "number" || typeof value === "boolean"),
  )
  if (steps.length === 0 && fields.length === 0 && questions.length === 0) return null

  return (
    <div className="min-w-0">
      {steps.length > 0 && <PlanInput steps={steps} />}
      {questions.length > 0 && <QuestionInput questions={questions} />}
      {fields.length > 0 && (
        <dl className="mt-2 flex min-w-0 flex-col gap-2" aria-label="Call details">
          {fields.map(([key, value]) => (
            <div key={key} className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 text-xs">
              <dt className="max-w-32 break-words text-muted-foreground">{fieldLabel(key)}</dt>
              <dd className="min-w-0 leading-relaxed"><InputText value={fieldValue(key, value)} /></dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
