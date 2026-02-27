import { MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"

interface UserQuestionBarProps {
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
  onSend: (message: string) => void
}

export function UserQuestionBar({ questions, onSend }: UserQuestionBarProps) {
  // Handle multi-question responses: for now, render first question's options
  // (matches terminal behavior where questions are answered one at a time)
  const q = questions[0]
  if (!q) return null

  return (
    <div className="mb-2.5 rounded-lg border border-pink-500/30 bg-pink-500/5 p-2.5">
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center justify-center w-5 h-5 rounded-full bg-pink-500/20 shrink-0">
          <MessageSquare className="size-3 text-pink-400" />
        </div>
        <span className="text-xs text-pink-300">
          {q.header && <span className="font-medium mr-1.5">{q.header}</span>}
          {q.question}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {q.options.map((opt, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-xs border-pink-500/30 text-pink-300 hover:bg-pink-500/10 hover:text-pink-200 hover:border-pink-500/50"
                onClick={() => onSend(opt.label)}
              >
                {opt.label}
              </Button>
            </TooltipTrigger>
            {opt.description && (
              <TooltipContent className="max-w-[250px] text-xs">
                {opt.description}
              </TooltipContent>
            )}
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
