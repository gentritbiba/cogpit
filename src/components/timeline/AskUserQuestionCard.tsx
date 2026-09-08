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
import type { ToolCall } from "../../../shared/session/types"
import { cn } from "@/lib/utils"
import { AskUserAnswerForm } from "./AskUserAnswerForm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

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
  // An async question's result is an acceptance receipt, never an answer.
  if (toolCall.asyncQuestion) return {}

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
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge variant="outline" className="size-5 rounded-full p-0 font-mono text-muted-foreground">
          {index + 1}
        </Badge>
        {question.header && (
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {question.header}
          </span>
        )}
      </div>

      <p className="text-sm leading-relaxed text-foreground">
        {question.question}
      </p>

      {options.length > 0 && (
        <div className="mt-2 flex flex-col divide-y divide-border">
          {options.map((option, optionIndex) => {
            const selected = isSelectedOption(question, answer, option.label)
            return (
              <div
                key={`${option.label}-${optionIndex}`}
                className={cn(
                  "flex items-start gap-2.5 py-2",
                  selected
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                    question.multiSelect ? "rounded" : "rounded-full",
                    selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
                  )}
                  aria-hidden="true"
                >
                  {selected && <Check className="size-3" strokeWidth={3} data-icon="icon" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">
                    {option.label}
                    {selected && (
                      <Badge variant="secondary" className="ml-2">Selected</Badge>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
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
        <div className="mt-2 border-l-2 border-border pl-3">
          <div className="mb-0.5 text-xs font-medium text-muted-foreground">Answer</div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
            {answer.trim() || "No answer provided"}
          </p>
        </div>
      )}
    </div>
  )
}

export function AskUserQuestionCard({
  toolCall,
  expandToolPayloads,
  isAwaitingAnswer,
  sessionId,
}: {
  toolCall: ToolCall
  expandToolPayloads: boolean
  /** True when this question is the session's pending interaction. */
  isAwaitingAnswer?: boolean
  sessionId?: string
}): React.ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const questions = useMemo(() => getQuestions(toolCall), [toolCall])
  const answers = useMemo(() => getAnswers(toolCall, questions), [toolCall, questions])
  const showRawDetails = expandToolPayloads || detailsOpen
  // An async question is never answered by its own result, so it stays open
  // until the reader replies — which the card reports through isAwaitingAnswer.
  const isAnswered = toolCall.result !== null && !toolCall.isError && !toolCall.asyncQuestion
  // questions.length guards the form branch from rendering an empty body:
  // AskUserAnswerForm returns null when it has nothing to ask.
  const isWaiting = !isAnswered && !toolCall.isError
    && isAwaitingAnswer && Boolean(sessionId) && questions.length > 0
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
        "my-1 overflow-hidden rounded-lg border bg-card",
        toolCall.isError && "border-destructive/30",
      )}
      aria-label="Question history"
    >
      <header className="flex items-start gap-2.5 border-b px-3 py-2.5">
        <CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" data-icon="inline-start" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium text-foreground">Decision requested</h3>
            <span className="text-xs text-muted-foreground">
              {questions.length} {questions.length === 1 ? "question" : "questions"}
            </span>
          </div>
          <Badge variant={toolCall.isError ? "destructive" : isAnswered ? "secondary" : "outline"}>
            <Status data-icon="inline-start" />
            {statusLabel}
          </Badge>
        </div>
        {toolCall.timestamp && (
          <time className="hidden shrink-0 pt-0.5 font-mono text-xs tabular-nums text-muted-foreground sm:block">
            {new Date(toolCall.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
        )}
      </header>

      <div className="px-3">
        {isWaiting && sessionId ? (
          <AskUserAnswerForm toolCall={toolCall} sessionId={sessionId} embedded />
        ) : questions.length > 0 ? (
          questions.map((question, index) => (
            <QuestionHistoryItem
              key={`${question.question}-${index}`}
              question={question}
              answer={answers[question.question]}
              index={index}
              completed={toolCall.result !== null && !toolCall.asyncQuestion}
            />
          ))
        ) : (
          <p className="py-3 text-sm text-muted-foreground">
            Question details are unavailable.
          </p>
        )}

        {toolCall.result !== null && !toolCall.asyncQuestion && !hasStructuredAnswers && (
          <div className={cn(
            "border-t border-border py-3",
            toolCall.isError
              ? "text-destructive"
              : "text-muted-foreground",
          )}>
            <div className="mb-0.5 text-xs font-semibold uppercase tracking-wide opacity-70">
              Recorded response
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {toolCall.result}
            </p>
          </div>
        )}
      </div>

      <div className="border-t px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            if (!expandToolPayloads) setDetailsOpen((open) => !open)
          }}
          className="-ml-2 text-muted-foreground"
          aria-expanded={showRawDetails}
        >
          {showRawDetails
            ? <ChevronDown data-icon="inline-start" />
            : <ChevronRight data-icon="inline-start" />}
          Raw details
        </Button>

        {showRawDetails && (
          <div className="mt-1.5 grid gap-2 pb-1.5 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Input
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed text-muted-foreground">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
            {toolCall.result !== null && (
              <div className="min-w-0">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Result
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed text-muted-foreground">
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
