import type { PendingInput } from "../agents/pendingInput"

export const CLI_NAME = "cogpit-session"

/** How to answer each pending request, spelled as the command to run. */
export function answerHints(sessionId: string, waiting: readonly PendingInput[]): string[] {
  return waiting.map((request) => {
    const target = `${CLI_NAME} %s ${sessionId} --request ${request.requestId}`
    switch (request.kind) {
      case "permission":
        return `${target.replace("%s", "approve")}  |  ${target.replace("%s", "deny")}`
      case "plan":
        return `${target.replace("%s", "approve")}  |  ${target.replace("%s", "deny")} --feedback "..."`
      case "question":
        return `${target.replace("%s", "answer")} "<one answer per question>"${request.skippable ? `  |  ${target.replace("%s", "answer")} --skip` : ""}`
    }
  })
}
