import { useState } from "react"
import { Check } from "lucide-react"
import type { ToolCall } from "@/lib/types"
import { authFetch } from "@/lib/auth"
import { cn } from "@/lib/utils"

interface AskUserQuestion {
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  type?: string
}

export function AskUserAnswerForm({
  toolCall,
  sessionId,
  embedded = false,
}: {
  toolCall: ToolCall
  sessionId: string
  embedded?: boolean
}): React.ReactElement | null {
  const questions = (toolCall.input.questions as AskUserQuestion[] | undefined) ?? []
  const [answers, setAnswers] = useState<Record<string, string>>(() => (
    Object.fromEntries(questions.map((question) => [question.question, ""]))
  ))
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (questions.length === 0) return null

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const response = await authFetch("/api/ask-user-answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, toolUseId: toolCall.id, answers }),
      })
      if (response.ok) {
        setSubmitted(true)
      } else {
        const data = await response.json() as { error?: string }
        setError(data.error ?? "Failed to submit answer")
      }
    } catch {
      setError("Network error")
    }
    setSubmitting(false)
  }

  return (
    <form
      onSubmit={(event) => { void handleSubmit(event) }}
      className={cn(
        "space-y-3",
        !embedded && "mt-2 rounded-md border border-pink-500/30 bg-pink-500/5 p-2.5",
        submitted && "opacity-50 pointer-events-none",
      )}
    >
      {questions.map((question, questionIndex) => {
        const isMultipleChoice = question.options && question.options.length > 0
        const selectedAnswers = new Set(
          question.multiSelect
            ? (answers[question.question] ?? "").split(", ").filter(Boolean)
            : [],
        )
        const answerInputId = `ask-user-answer-${toolCall.id}-${questionIndex}`
        return (
          <div key={questionIndex} className="space-y-2">
            {(question.header || question.question) && (
              <div>
                {question.header && (
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-pink-300/75">
                    {question.header}
                  </div>
                )}
                <div className="text-[13px] leading-relaxed text-foreground/90">
                  {question.question}
                </div>
              </div>
            )}
            {isMultipleChoice ? (
              <div className="grid gap-1.5">
                {question.options!.map((option, optionIndex) => {
                  const isSelected = question.multiSelect
                    ? selectedAnswers.has(option.label)
                    : answers[question.question] === option.label
                  return (
                    <button
                      key={optionIndex}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        const nextSelected = new Set(selectedAnswers)
                        if (nextSelected.has(option.label)) {
                          nextSelected.delete(option.label)
                        } else {
                          nextSelected.add(option.label)
                        }
                        const nextValue = question.multiSelect
                          ? Array.from(nextSelected).join(", ")
                          : option.label
                        setAnswers({ ...answers, [question.question]: nextValue })
                      }}
                      className={cn(
                        "flex items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                        isSelected
                          ? "border-pink-500/50 bg-pink-500/15 text-pink-100"
                          : "border-border/50 bg-elevation-1/70 text-foreground/80 hover:border-pink-500/30 hover:bg-pink-500/[0.07]",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                          question.multiSelect ? "rounded" : "rounded-full",
                          isSelected
                            ? "border-pink-400 bg-pink-500 text-white"
                            : "border-muted-foreground/30",
                        )}
                        aria-hidden="true"
                      >
                        {isSelected && <Check className="size-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="space-y-1">
                <label
                  htmlFor={answerInputId}
                  className="text-[10px] font-semibold uppercase tracking-[0.08em] text-pink-300/75"
                >
                  Answer
                </label>
                <textarea
                  id={answerInputId}
                  value={answers[question.question] ?? ""}
                  onChange={(event) => {
                    setAnswers({ ...answers, [question.question]: event.target.value })
                  }}
                  rows={2}
                  className="w-full resize-none rounded-md border border-pink-500/20 bg-elevation-1 p-2.5 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-pink-500/50 focus:outline-none"
                  placeholder="Type your answer..."
                />
              </div>
            )}
          </div>
        )
      })}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting || submitted}
        className="rounded-md border border-pink-500/40 bg-pink-500/15 px-3 py-1.5 text-xs font-medium text-pink-200 transition-colors hover:bg-pink-500/25 disabled:opacity-50"
      >
        {submitted ? "Sent" : submitting ? "Sending..." : "Send answer"}
      </button>
    </form>
  )
}
