/**
 * The inline answer block for a session blocked on AskUserQuestion.
 *
 * A call carries up to four questions, each with up to four options and a
 * sentence of description. Rendering all of that would triple the card's height
 * and wreck the grid, so questions are answered one at a time with an `n of N`
 * counter — the common single-question case stays a one-click answer, and one
 * POST resolves the whole tool at the end.
 */

import { useState } from "react"
import { ChevronRight, MessageCircleQuestion } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { joinMultiSelect, type UserQuestionAnswerMap } from "@/lib/askUserApi"
import type {
  MissionControlQuestion,
  MissionControlQuestionItem,
} from "../../../shared/contracts/missionControl"

interface QuestionPromptProps {
  request: MissionControlQuestion
  responding: boolean
  /** True once the server said it no longer knows about this question. */
  gone: boolean
  onAnswer: (toolUseId: string, answers: UserQuestionAnswerMap) => void
  onOpenSession: () => void
}

const ACTION_BUTTON = "rounded border px-2.5 py-1 text-[11px] font-medium transition-colors"

/**
 * Some calls cannot be answered honestly from a card: a question with no
 * options needs free text, and an option carrying a preview (a mockup, a code
 * snippet) is meant to be *looked at* before choosing. Rather than let someone
 * pick blind, those hand off to the session.
 */
function needsFullView(questions: MissionControlQuestionItem[]): boolean {
  return questions.some((q) => q.options.length === 0 || q.options.some((o) => o.hasPreview))
}

export function QuestionPrompt({
  request,
  responding,
  gone,
  onAnswer,
  onOpenSession,
}: QuestionPromptProps) {
  const questions = request.questions
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<UserQuestionAnswerMap>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())

  if (questions.length === 0) return null

  if (needsFullView(questions)) {
    return (
      <Shell>
        <p className="text-[11.5px] leading-relaxed text-pink-100/80">{questions[0].question}</p>
        <button
          type="button"
          onClick={onOpenSession}
          className={cn(
            ACTION_BUTTON,
            "mt-2 flex items-center gap-1 border-pink-500/40 bg-pink-500/15 text-pink-200 hover:bg-pink-500/25",
          )}
        >
          Open session — this one needs the full view
          <ChevronRight className="size-3" />
        </button>
      </Shell>
    )
  }

  const current = questions[index]

  /** Record an answer, then advance or submit the completed set. */
  function commit(value: string) {
    const next = { ...answers, [current.question]: value }
    if (index + 1 < questions.length) {
      setAnswers(next)
      setSelected(new Set())
      setIndex(index + 1)
      return
    }
    onAnswer(request.toolUseId, next)
  }

  function toggle(label: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }

  return (
    <Shell>
      <div className="flex items-baseline gap-1.5">
        {current.header && (
          <span className="shrink-0 rounded bg-pink-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-pink-300">
            {current.header}
          </span>
        )}
        {questions.length > 1 && (
          <span className="ml-auto shrink-0 font-mono text-[9.5px] text-pink-300/60">
            {index + 1} of {questions.length}
          </span>
        )}
      </div>

      <p
        className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-pink-100/85"
        title={current.question}
      >
        {current.question}
      </p>

      <div className="mt-1.5 flex flex-col gap-1">
        {current.options.map((option) => (
          // Descriptions are full sentences — inline they would triple the
          // card height, so they live in the hover card.
          <WithTooltip key={option.label} text={option.description}>
            <button
              type="button"
              disabled={responding}
              onClick={() => (current.multiSelect ? toggle(option.label) : commit(option.label))}
              className={cn(
                "flex w-full items-center gap-1.5 rounded border px-2 py-1 text-left text-[11px] transition-colors disabled:opacity-50",
                selected.has(option.label)
                  ? "border-pink-400/60 bg-pink-500/25 text-pink-100"
                  : "border-pink-500/25 bg-pink-500/5 text-pink-100/85 hover:bg-pink-500/15",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 border",
                  current.multiSelect ? "rounded-[2px]" : "rounded-full",
                  selected.has(option.label) ? "border-pink-300 bg-pink-400" : "border-pink-400/40",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </button>
          </WithTooltip>
        ))}
      </div>

      <div className="mt-1.5 flex items-center gap-2">
        {current.multiSelect && (
          <button
            type="button"
            disabled={responding || selected.size === 0}
            onClick={() => commit(joinMultiSelect(selected))}
            className={cn(
              ACTION_BUTTON,
              "border-pink-400/50 bg-pink-500/20 text-pink-100 hover:bg-pink-500/30 disabled:opacity-40",
            )}
          >
            {index + 1 < questions.length ? "Next" : "Send"}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSession}
          className="ml-auto flex items-center gap-0.5 text-[10.5px] text-pink-300/70 transition-colors hover:text-pink-200"
        >
          Other / open session
          <ChevronRight className="size-3" />
        </button>
      </div>

      {gone && (
        <p className="mt-1.5 text-[10.5px] text-amber-300/90">
          Couldn’t answer from here — it may already be answered. Open the session.
        </p>
      )}
    </Shell>
  )
}

function WithTooltip({ text, children }: { text?: string; children: React.ReactElement }) {
  if (!text) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right" className="max-w-[250px]">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-pink-500/40 bg-pink-500/[0.07] p-2">
      <div className="flex items-center gap-1.5">
        <MessageCircleQuestion className="size-3.5 shrink-0 text-pink-400" />
        <span className="text-[11.5px] font-medium text-pink-200">Answer to continue</span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  )
}
