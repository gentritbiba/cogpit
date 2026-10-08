import { ClipboardCheck } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { PermissionPrompt } from "@/components/pending-input/PermissionPrompt"
import { QuestionPrompt } from "@/components/pending-input/QuestionPrompt"
import type { PendingInput, PendingInputResponse } from "../../shared/contracts/pendingInput"

/**
 * One request a session is blocked on, answerable in place: a permission, a
 * question or a plan, with the controls Mission Control uses for each.
 */
export function PendingInputPrompt({
  sessionId,
  pending,
  queued,
  responding,
  onRespond,
  onOpen,
}: {
  sessionId: string
  pending: PendingInput
  queued: number
  responding: boolean
  onRespond: (requestId: string, response: PendingInputResponse) => void
  onOpen: () => void
}) {
  switch (pending.kind) {
    case "permission":
      return (
        <PermissionPrompt
          request={{ ...pending, sessionId, timestamp: 0 }}
          queued={queued}
          responding={responding}
          onRespond={(requestId, decision) => onRespond(requestId, { decision })}
        />
      )
    case "question":
      return (
        <QuestionPrompt
          request={{
            sessionId,
            toolUseId: pending.requestId,
            askedAt: 0,
            questions: pending.questions.map((question) => ({
              question: question.question,
              multiSelect: question.multiSelect,
              options: question.options.map((label) => ({ label, hasPreview: false })),
            })),
          }}
          responding={responding}
          gone={false}
          onAnswer={(requestId, answers) => onRespond(requestId, { answers })}
          onOpenSession={onOpen}
        />
      )
    case "plan":
      return (
        <Alert className="border-info/40 bg-info/5">
          <ClipboardCheck className="text-info" />
          <AlertTitle>Approve the plan?</AlertTitle>
          {pending.summary && (
            <p className="col-start-2 mt-1 line-clamp-3 text-sm text-foreground">{pending.summary}</p>
          )}
          <div className="col-start-2 mt-3 flex items-center gap-2">
            <Button size="xs" disabled={responding} onClick={() => onRespond(pending.requestId, { approved: true })}>
              Approve
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={responding}
              onClick={() => onRespond(pending.requestId, { approved: false })}
            >
              Reject
            </Button>
          </div>
        </Alert>
      )
  }
}
