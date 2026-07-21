import { useState } from "react"
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
}: {
  toolCall: ToolCall
  sessionId: string
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
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={(event) => { void handleSubmit(event) }}
      className={cn(
        "mt-2 rounded-md border border-pink-500/30 bg-pink-500/5 p-2.5 space-y-2",
        submitted && "opacity-50 pointer-events-none",
      )}
    >
      {questions.map((question, questionIndex) => {
        const isMultipleChoice = question.options && question.options.length > 0
        return (
          <div key={questionIndex} className="space-y-1">
            {(question.header || question.question) && (
              <div className="text-[11px] text-pink-300">
                {question.header && <span className="font-medium mr-1">{question.header}</span>}
                {question.question}
              </div>
            )}
            {isMultipleChoice ? (
              <div className="flex flex-wrap gap-1.5">
                {question.options!.map((option, optionIndex) => (
                  <button
                    key={optionIndex}
                    type="button"
                    onClick={() => {
                      const current = answers[question.question] ?? ""
                      const selected = question.multiSelect
                        ? current.split(", ").filter(Boolean)
                        : []
                      const nextValue = question.multiSelect
                        ? selected.includes(option.label)
                          ? selected.filter((label) => label !== option.label).join(", ")
                          : [...selected, option.label].join(", ")
                        : option.label
                      setAnswers({ ...answers, [question.question]: nextValue })
                    }}
                    className={cn(
                      "text-[11px] px-2 py-0.5 rounded border transition-colors",
                      (question.multiSelect
                        ? (answers[question.question] ?? "").split(", ").includes(option.label)
                        : answers[question.question] === option.label)
                        ? "border-pink-500/60 bg-pink-500/20 text-pink-200"
                        : "border-pink-500/20 text-pink-400 hover:bg-pink-500/10",
                    )}
                    title={option.description}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : (
              <textarea
                value={answers[question.question] ?? ""}
                onChange={(event) => {
                  setAnswers({ ...answers, [question.question]: event.target.value })
                }}
                rows={2}
                className="w-full text-[11px] font-mono bg-elevation-2 border border-pink-500/20 rounded p-1.5 text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:border-pink-500/50"
                placeholder="Type your answer..."
              />
            )}
          </div>
        )
      })}
      {error && <p className="text-[10px] text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting || submitted}
        className="text-[11px] px-2.5 py-1 rounded border border-pink-500/40 bg-pink-500/15 text-pink-300 hover:bg-pink-500/25 transition-colors disabled:opacity-50"
      >
        {submitted ? "Sent" : submitting ? "Sending..." : "Send answer"}
      </button>
    </form>
  )
}
