import { useState } from "react"
import { ChevronRight, ClipboardCheck, ShieldQuestion } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ElicitationPrompt } from "@/components/pending-input/ElicitationPrompt"
import { PermissionPrompt } from "@/components/pending-input/PermissionPrompt"
import { QuestionPrompt } from "@/components/pending-input/QuestionPrompt"
import { UserDialogPrompt } from "@/components/pending-input/UserDialogPrompt"
import type { PendingHumanInput } from "@/contexts/PendingHumanInputContext"
import type { HomeRequest } from "./homeView"

/**
 * One request from the queue, answered in place with the controls the
 * session itself would show. Plans and deferred permissions are answered in
 * their session, so they offer the way there.
 */
export function HomeRequestPrompt({
  request,
  input,
  canAnswer,
  onOpen,
}: {
  request: HomeRequest
  input: PendingHumanInput
  canAnswer: boolean
  onOpen: () => void
}) {
  const [goneQuestions, setGoneQuestions] = useState<ReadonlySet<string>>(new Set())
  const { sessionId } = request
  switch (request.kind) {
    case "permission":
      return (
        <PermissionPrompt
          request={request.request}
          queued={0}
          responding={input.responding.has(request.request.requestId)}
          onRespond={canAnswer ? (requestId, decision) => void input.respond(sessionId, requestId, decision) : undefined}
        />
      )
    case "question":
      return (
        <QuestionPrompt
          request={request.request}
          responding={input.responding.has(request.request.toolUseId)}
          gone={goneQuestions.has(request.request.toolUseId)}
          onAnswer={canAnswer
            ? async (toolUseId, answers) => {
              const result = await input.answerQuestion(sessionId, toolUseId, answers)
              if (result.gone) setGoneQuestions((gone) => new Set(gone).add(toolUseId))
            }
            : undefined}
          onOpenSession={onOpen}
        />
      )
    case "elicitation":
      return (
        <ElicitationPrompt
          request={request.request}
          responding={input.responding.has(request.request.requestId)}
          onAnswer={canAnswer ? (requestId, answer) => void input.answerElicitation(sessionId, requestId, answer) : undefined}
        />
      )
    case "dialog":
      return (
        <UserDialogPrompt
          request={request.request}
          responding={input.responding.has(request.request.requestId)}
          onChoose={canAnswer ? (requestId, choice) => void input.answerDialog(sessionId, requestId, choice) : undefined}
        />
      )
    case "plan":
    case "deferred":
      return (
        <Alert className="border-warning/40 bg-warning/5">
          {request.kind === "plan" ? <ClipboardCheck className="text-warning" /> : <ShieldQuestion className="text-warning" />}
          <AlertTitle>{request.kind === "plan" ? "A plan is waiting for review" : "A permission was deferred"}</AlertTitle>
          <p className="col-start-2 mt-1 text-sm text-muted-foreground">
            {request.kind === "plan" ? "Review it in its session." : "Open the session and resume it to answer."}
          </p>
          <div className="col-start-2 mt-2">
            <Button size="xs" onClick={onOpen}>
              Open session
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </Alert>
      )
  }
}
