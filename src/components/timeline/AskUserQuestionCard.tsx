import { useMemo, useState } from "react"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
} from "lucide-react"
import type { ToolCall } from "@/lib/types"
import { cn } from "@/lib/utils"
import { AskUserAnswerForm } from "./AskUserAnswerForm"

interface AskUserQuestion {
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

function getQuestions(toolCall: ToolCall): AskUserQuestion[] {
  if (!Array.isArray(toolCall.input.questions)) return []

  return toolCall.input.questions.filter((question): question is AskUserQuestion => (
    typeof question === "object" &&
    question !== null &&
    typeof (question as { question?: unknown }).question === "string"
  ))
}

function decodeQuotedText(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
}

function parseQuotedAnswers(result: string): Record<string, string> {
  const answers: Record<string, string> = {}
  const pairPattern = /"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"/g
  let match: RegExpExecArray | null

  while ((match = pairPattern.exec(result)) !== null) {
    answers[decodeQuotedText(match[1])] = decodeQuotedText(match[2])
  }

  return answers
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function inferOptionAnswer(question: AskUserQuestion, result: string): string | undefined {
  const matches = (question.options ?? []).filter((option) => {
    const label = option.label.trim()
    if (!label) return false
    return new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRegExp(label)}(?=$|[^\\p{L}\\p{N}])`,
      "iu",
    ).test(result)
  })

  return matches.length === 1 ? matches[0].label : undefined
}

function getAnswers(toolCall: ToolCall, questions: AskUserQuestion[]): Record<string, string> {
  const inputAnswers = toolCall.input.answers
  if (typeof inputAnswers === "object" && inputAnswers !== null && !Array.isArray(inputAnswers)) {
    const entries = Object.entries(inputAnswers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
    if (entries.length > 0) return Object.fromEntries(entries)
  }

  if (!toolCall.result) return {}

  const parsed = parseQuotedAnswers(toolCall.result)
  for (const question of questions) {
    if (parsed[question.question] === undefined) {
      const inferred = inferOptionAnswer(question, toolCall.result)
      if (inferred !== undefined) parsed[question.question] = inferred
    }
  }
  return parsed
}

function isSelectedOption(question: AskUserQuestion, answer: string | undefined, label: string): boolean {
  if (answer === undefined) return false
  if (!question.multiSelect) return answer === label
  return answer.split(/,\s*/).includes(label)
}

function QuestionHistoryItem({
  question,
  answer,
  index,
  completed,
}: {
  question: AskUserQuestion
  answer?: string
  index: number
  completed: boolean
}): React.ReactElement {
  const options = question.options ?? []
  const selectedOptionCount = options.filter((option) => (
    isSelectedOption(question, answer, option.label)
  )).length
  const showWrittenAnswer = completed && answer !== undefined && selectedOptionCount === 0

  return (
    <div className="rounded-lg border border-border/50 bg-elevation-1/70 p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-pink-500/10 font-mono text-[10px] text-pink-300">
          {index + 1}
        </span>
        {question.header && (
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-pink-300/80">
            {question.header}
          </span>
        )}
      </div>

      <p className="text-[13px] leading-relaxed text-foreground/90">
        {question.question}
      </p>

      {options.length > 0 && (
        <div className="mt-2.5 grid gap-1.5">
          {options.map((option, optionIndex) => {
            const selected = isSelectedOption(question, answer, option.label)
            return (
              <div
                key={`${option.label}-${optionIndex}`}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border px-2.5 py-2",
                  selected
                    ? "border-pink-500/40 bg-pink-500/10 text-foreground"
                    : "border-border/40 bg-elevation-0/40 text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                    question.multiSelect ? "rounded" : "rounded-full",
                    selected
                      ? "border-pink-400 bg-pink-500 text-white"
                      : "border-muted-foreground/30",
                  )}
                  aria-hidden="true"
                >
                  {selected && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-xs font-medium", selected && "text-pink-200")}>
                    {option.label}
                    {selected && (
                      <span className="ml-2 text-[9px] font-semibold uppercase tracking-wide text-pink-300/70">
                        Selected
                      </span>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {showWrittenAnswer && (
        <div className="mt-2.5 rounded-md border border-pink-500/25 bg-pink-500/[0.07] px-2.5 py-2">
          <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-pink-300/70">
            Answer
          </div>
          <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
            {answer.trim() || "No answer provided"}
          </p>
        </div>
      )}
    </div>
  )
}

export function AskUserQuestionCard({
  toolCall,
  expandAll,
  isAgentActive,
  sessionId,
}: {
  toolCall: ToolCall
  expandAll: boolean
  isAgentActive?: boolean
  sessionId?: string
}): React.ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const questions = useMemo(() => getQuestions(toolCall), [toolCall])
  const answers = useMemo(() => getAnswers(toolCall, questions), [toolCall, questions])
  const showRawDetails = expandAll || detailsOpen
  const isAnswered = toolCall.result !== null && !toolCall.isError
  const isWaiting = toolCall.result === null && isAgentActive && Boolean(sessionId)
  const hasStructuredAnswers = Object.keys(answers).length > 0

  const Status = toolCall.isError
    ? AlertCircle
    : isAnswered
      ? CheckCircle2
      : Clock3
  const statusLabel = toolCall.isError
    ? "Not answered"
    : isAnswered
      ? "Answered"
      : isWaiting
        ? "Waiting for answer"
        : "No answer recorded"

  return (
    <section
      className={cn(
        "my-1 overflow-hidden rounded-xl border bg-pink-500/[0.035]",
        toolCall.isError ? "border-red-500/25" : "border-pink-500/25",
      )}
      aria-label="Question history"
    >
      <header className="flex items-start gap-2.5 border-b border-pink-500/15 px-3 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-pink-500/20 bg-pink-500/10">
          <CircleHelp className="size-4 text-pink-300" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-xs font-semibold text-foreground">Decision requested</h3>
            <span className="text-[10px] text-muted-foreground">
              {questions.length} {questions.length === 1 ? "question" : "questions"}
            </span>
          </div>
          <div className={cn(
            "mt-0.5 inline-flex items-center gap-1 text-[10px]",
            toolCall.isError
              ? "text-red-300"
              : isAnswered
                ? "text-emerald-400"
                : "text-pink-300/80",
          )}>
            <Status className={cn("size-3", isWaiting && "animate-pulse")} />
            {statusLabel}
          </div>
        </div>
        {toolCall.timestamp && (
          <time className="hidden shrink-0 pt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/45 sm:block">
            {new Date(toolCall.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        )}
      </header>

      <div className="space-y-2 p-2.5 sm:p-3">
        {isWaiting && sessionId ? (
          <AskUserAnswerForm toolCall={toolCall} sessionId={sessionId} embedded />
        ) : questions.length > 0 ? (
          questions.map((question, index) => (
            <QuestionHistoryItem
              key={`${question.question}-${index}`}
              question={question}
              answer={answers[question.question]}
              index={index}
              completed={toolCall.result !== null}
            />
          ))
        ) : (
          <p className="rounded-md border border-border/40 bg-elevation-1 p-2.5 text-xs text-muted-foreground">
            Question details are unavailable.
          </p>
        )}

        {toolCall.result !== null && !hasStructuredAnswers && (
          <div className={cn(
            "rounded-md border px-2.5 py-2",
            toolCall.isError
              ? "border-red-500/25 bg-red-500/[0.07] text-red-200"
              : "border-border/40 bg-elevation-1 text-muted-foreground",
          )}>
            <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] opacity-70">
              Recorded response
            </div>
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">
              {toolCall.result}
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-pink-500/10 px-3 py-1.5">
        <button
          type="button"
          onClick={() => {
            if (!expandAll) setDetailsOpen((open) => !open)
          }}
          className="flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
          aria-expanded={showRawDetails}
        >
          {showRawDetails
            ? <ChevronDown className="size-3" />
            : <ChevronRight className="size-3" />}
          Raw details
        </button>

        {showRawDetails && (
          <div className="mt-1.5 grid gap-2 pb-1.5 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                Input
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/30 bg-elevation-0 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
            {toolCall.result !== null && (
              <div className="min-w-0">
                <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                  Result
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/30 bg-elevation-0 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {toolCall.result}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
