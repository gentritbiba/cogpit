import { useState } from "react"
import { Check } from "lucide-react"
import type { ToolCall } from "../../../shared/session/types"
import { submitUserQuestionAnswers } from "@/lib/askUserApi"
import { useSessionChatContext } from "@/contexts/SessionContext"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

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
  const { chat: { sendMessage } } = useSessionChatContext()

  if (questions.length === 0) return null

  /**
   * The server can refuse the answer for reasons the user cannot act on: the
   * session was started from the terminal so this server never owned the
   * blocked tool, it restarted, or the question was answered from another
   * device. Never make the user retype — deliver the answer as a normal
   * message, which resumes the session. Mirrors the composer's question bar.
   */
  const deliverAsMessage = () => {
    const text = questions
      .map((question) => {
        const answer = answers[question.question]?.trim()
        if (!answer) return null
        return questions.length > 1 ? `${question.question}\n${answer}` : answer
      })
      .filter(Boolean)
      .join("\n\n")
    if (text) sendMessage(text)
    setSubmitted(true)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    try {
      const result = await submitUserQuestionAnswers(sessionId, toolCall.id, answers)
      if (result.ok) {
        setSubmitted(true)
      } else {
        deliverAsMessage()
      }
    } catch {
      deliverAsMessage()
    }
    setSubmitting(false)
  }

  return (
    <form
      onSubmit={(event) => { void handleSubmit(event) }}
      className={cn(
        "flex flex-col gap-3",
        !embedded && "mt-2 rounded-md border bg-card p-3",
        submitted && "pointer-events-none opacity-50",
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
          <FieldSet key={questionIndex} className="gap-2 border-b border-border pb-3 last:border-b-0 last:pb-0">
            {(question.header || question.question) && (
              <FieldLegend variant="label" className="flex flex-col items-start gap-1">
                {question.header && (
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {question.header}
                  </span>
                )}
                <span className="text-sm leading-relaxed text-foreground">
                  {question.question}
                </span>
              </FieldLegend>
            )}
            {isMultipleChoice ? (
              <ToggleGroup
                multiple={question.multiSelect}
                orientation="vertical"
                variant="outline"
                value={question.multiSelect
                  ? Array.from(selectedAnswers)
                  : answers[question.question]
                    ? [answers[question.question]]
                    : []}
                onValueChange={(nextSelected) => {
                  if (!question.multiSelect && nextSelected.length === 0) return
                  const nextValue = question.multiSelect
                    ? nextSelected.join(", ")
                    : nextSelected[0]
                  setAnswers({ ...answers, [question.question]: nextValue })
                }}
                className="grid w-full gap-1.5"
              >
                {question.options!.map((option, optionIndex) => {
                  const isSelected = question.multiSelect
                    ? selectedAnswers.has(option.label)
                    : answers[question.question] === option.label
                  return (
                    <ToggleGroupItem
                      key={optionIndex}
                      value={option.label}
                      aria-label={option.label}
                      className="h-auto w-full justify-start whitespace-normal px-3 py-2.5 text-left"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                          question.multiSelect ? "rounded" : "rounded-full",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/30",
                        )}
                        aria-hidden="true"
                      >
                        {isSelected && <Check className="size-3" strokeWidth={3} data-icon="icon" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium">{option.label}</span>
                        {option.description && (
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </ToggleGroupItem>
                  )
                })}
              </ToggleGroup>
            ) : (
              <Field>
                <FieldLabel
                  htmlFor={answerInputId}
                >
                  Answer
                </FieldLabel>
                <Textarea
                  id={answerInputId}
                  value={answers[question.question] ?? ""}
                  onChange={(event) => {
                    setAnswers({ ...answers, [question.question]: event.target.value })
                  }}
                  rows={2}
                  placeholder="Type your answer..."
                />
              </Field>
            )}
          </FieldSet>
        )
      })}
      <Button
        type="submit"
        size="sm"
        disabled={submitting || submitted}
      >
        {submitted ? "Sent" : submitting ? "Sending..." : "Send answer"}
      </Button>
    </form>
  )
}
