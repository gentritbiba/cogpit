/**
 * The inline answer block for a session blocked on AskUserQuestion.
 *
 * A call carries up to four questions, each with up to four options and a
 * sentence of description. Rendering all of that would triple the card's height
 * and wreck the grid, so questions are answered one at a time with an `n of N`
 * counter — the common single-question case stays a one-click answer, and one
 * POST resolves the whole tool at the end.
 */

import { useRef, useState } from "react"
import { ChevronRight, MessageCircleQuestion } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { joinMultiSelect, type UserQuestionAnswerMap } from "@/lib/askUserApi"
import type {
  MissionControlQuestion,
  MissionControlQuestionItem,
  MissionControlQuestionOption,
} from "../../../shared/contracts/missionControl"

interface QuestionPromptProps {
  request: MissionControlQuestion
  responding: boolean
  /** True once the server said it no longer knows about this question. */
  gone: boolean
  onAnswer: (toolUseId: string, answers: UserQuestionAnswerMap) => void
  onOpenSession: () => void
}

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
  const answersRef = useRef<UserQuestionAnswerMap>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())

  if (questions.length === 0) return null

  if (needsFullView(questions)) {
    return (
      <Shell>
        <p className="text-sm leading-relaxed text-foreground">{questions[0].question}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenSession}
          className="mt-3"
        >
          Open full question
          <ChevronRight data-icon="inline-end" />
        </Button>
      </Shell>
    )
  }

  const current = questions[index]

  /** Record an answer, then advance or submit the completed set. */
  function commit(value: string) {
    const next = { ...answersRef.current, [current.question]: value }
    if (index + 1 < questions.length) {
      answersRef.current = next
      setSelected(new Set())
      setIndex(index + 1)
      return
    }
    onAnswer(request.toolUseId, next)
  }

  return (
    <Shell>
      <div className="flex items-baseline gap-1.5">
        {current.header && (
          <Badge variant="outline" className="border-info/40 text-info">
            {current.header}
          </Badge>
        )}
        {questions.length > 1 && (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {index + 1} of {questions.length}
          </span>
        )}
      </div>

      <p
        className="mt-2 line-clamp-3 text-sm leading-relaxed text-foreground"
        title={current.question}
      >
        {current.question}
      </p>

      <ToggleGroup
        value={[...selected]}
        onValueChange={(values) => {
          if (current.multiSelect) setSelected(new Set(values))
          else if (values[0]) commit(values[0])
        }}
        multiple={current.multiSelect}
        orientation="vertical"
        variant="outline"
        size="sm"
        className="mt-3 w-full items-stretch"
        aria-label={current.question}
      >
        {current.options.map((option) => (
          <OptionItem key={option.label} option={option} disabled={responding} />
        ))}
      </ToggleGroup>

      <div className="mt-3 flex items-center gap-2">
        {current.multiSelect && (
          <Button
            size="sm"
            disabled={responding || selected.size === 0}
            onClick={() => commit(joinMultiSelect(selected))}
          >
            {index + 1 < questions.length ? "Next" : "Send"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenSession}
          className="ml-auto text-muted-foreground"
        >
          Open session
          <ChevronRight data-icon="inline-end" />
        </Button>
      </div>

      {gone && (
        <p className="mt-2 text-xs text-warning">
          This question may already be answered. Open the session to check.
        </p>
      )}
    </Shell>
  )
}

/**
 * One answerable option.
 *
 * Descriptions are full sentences — inline they would triple the card height,
 * so they live in a hover card. It is a real tooltip rather than the native
 * `title` attribute because that renders on the OS's own delay and styling,
 * which reads as no description at all next to the rest of the surface.
 */
function OptionItem({
  option,
  disabled,
}: {
  option: MissionControlQuestionOption
  disabled: boolean
}) {
  const label = <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>

  if (!option.description) {
    return (
      <ToggleGroupItem
        value={option.label}
        disabled={disabled}
        className="w-full justify-start px-3"
      >
        {label}
      </ToggleGroupItem>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <ToggleGroupItem
            value={option.label}
            disabled={disabled}
            className="w-full justify-start px-3"
          />
        )}
      >
        {label}
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-72 text-left">
        {option.description}
      </TooltipContent>
    </Tooltip>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="border-info/40 bg-info/5">
      <MessageCircleQuestion className="text-info" />
      <AlertTitle>Answer to continue</AlertTitle>
      <div className="col-start-2 mt-1 min-w-0">{children}</div>
    </Alert>
  )
}
