import {
  dirs,
  dirname,
  mkdir,
  readFile,
  writeFile,
  join,
  randomUUID,
} from "../../helpers"
import { agentKindForDirName, descriptorFor } from "../../../shared/session/agent-descriptors"
import {
  cutLineAfterTurnIndex,
  cutLineAfterUuid,
  formatFor,
  turnBoundaryLines,
} from "../../../shared/session/agents"
import { storeFor, storeForPath } from "../../agents"
import { resolveSessionFilePath } from "../../sessionPaths"
import { withJsonBody, type UseFn } from "../../http"
import { copilotRuntime } from "../../agents/copilotTransport"

const codexDescriptor = descriptorFor("codex")
const copilotDescriptor = descriptorFor("copilot")

/**
 * Map a Copilot turn position onto the durable event id the CLI forks at.
 *
 * Copilot does not truncate a transcript — `sessions.fork` takes the id of the
 * first event to drop. Three encodings of `turnUuid` reach here because the
 * client builds turn ids from whichever of them the transcript carried.
 */
function copilotForkBoundary(
  lines: string[],
  turnIndex?: number,
  turnUuid?: string,
): string | undefined {
  const turns = turnBoundaryLines(formatFor("copilot"), lines).map((line) => {
    const event = JSON.parse(lines[line]) as Record<string, unknown>
    const data = event.data as Record<string, unknown>
    return {
      eventId: String(event.id),
      turnId: typeof data.turnId === "string" ? data.turnId : "",
    }
  })

  let targetIndex = -1
  if (turnUuid) {
    targetIndex = turns.findIndex(({ eventId, turnId }) => (
      turnUuid === eventId
      || turnUuid.endsWith(`@${eventId}`)
      || (turnId.length > 0 && turnUuid === `${turnId}@${eventId}`)
    ))
  }
  if (targetIndex < 0 && turnIndex !== undefined) targetIndex = turnIndex
  if (targetIndex < 0 || targetIndex >= turns.length - 1) return undefined
  return turns[targetIndex + 1].eventId
}

export function registerBranchSessionRoute(use: UseFn) {
  use("/api/branch-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    withJsonBody<{
      dirName?: string
      fileName?: string
      turnIndex?: number
      turnUuid?: string
    }>(req, res, async ({ dirName, fileName, turnIndex, turnUuid }) => {
      try {

        if (!dirName || !fileName) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "dirName and fileName are required" }))
          return
        }

        const sourcePath = await resolveSessionFilePath(dirName, fileName)
        const sourceAgentKind = agentKindForDirName(dirName)
        const isCopilot = sourceAgentKind === "copilot"
        // The resolved path has to sit in the storage of the agent the dirName
        // claims, so a Codex dirName cannot reach a Claude transcript.
        if (!sourcePath || storeForPath(sourcePath)?.kind !== sourceAgentKind) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }

        const content = await readFile(sourcePath, "utf-8")
        let lines = content.split("\n").filter(Boolean)

        if (lines.length === 0) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "Source session is empty" }))
          return
        }

        if (isCopilot) {
          const match = /^([0-9a-f-]{36})\/events\.jsonl$/i.exec(fileName)
          if (!match) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: "Invalid Copilot session path" }))
            return
          }
          const originalId = match[1]
          const toEventId = copilotForkBoundary(lines, turnIndex, turnUuid)
          const forked = await copilotRuntime.forkSession(
            originalId,
            toEventId ? { toEventId } : {},
          )
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            dirName,
            fileName: copilotDescriptor.sessionFile.name(forked.sessionId),
            sessionId: forked.sessionId,
            branchedFrom: originalId,
          }))
          return
        }

        if (turnIndex != null || typeof turnUuid === "string") {
          const format = formatFor(sourceAgentKind)
          // Prefer the uuid cut — exact regardless of how much of the session
          // the client had loaded. Fall back to the index cut when the uuid is
          // absent or unmatched (Codex turns have no stable uuids).
          let truncLine: number | null = null
          let resolvedByUuid = false
          if (typeof turnUuid === "string" && turnUuid) {
            const byUuid = cutLineAfterUuid(format, lines, turnUuid)
            if (byUuid !== null) {
              resolvedByUuid = true
              truncLine = byUuid === "keep-all" ? null : byUuid
            }
          }
          if (!resolvedByUuid && turnIndex != null) {
            truncLine = cutLineAfterTurnIndex(format, lines, turnIndex)
          }
          if (truncLine !== null) {
            lines = lines.slice(0, truncLine)
          }
        }

        const firstObj = JSON.parse(lines[0])
        const newSessionId = randomUUID()
        let originalId = ""
        let newFileName = descriptorFor("claude").sessionFile.name(newSessionId)
        let newPath = join(dirs.PROJECTS_DIR, dirName, newFileName)

        if (sourceAgentKind === "codex") {
          originalId = firstObj?.payload?.id || ""
          firstObj.payload.id = newSessionId
          firstObj.payload.branchedFrom = {
            sessionId: originalId,
            turnIndex: turnIndex ?? null,
          }
          lines[0] = JSON.stringify(firstObj)

          const relativeName = codexDescriptor.sessionFile.name(newSessionId)
          newFileName = relativeName
          newPath = join(storeFor("codex").sessionsRoot() ?? "", relativeName)
          await mkdir(dirname(newPath), { recursive: true })
        } else {
          originalId = firstObj.sessionId || ""
          firstObj.sessionId = newSessionId
          firstObj.branchedFrom = {
            sessionId: originalId,
            turnIndex: turnIndex ?? null,
          }
          lines[0] = JSON.stringify(firstObj)
        }

        await writeFile(newPath, lines.join("\n") + "\n")

        res.setHeader("Content-Type", "application/json")
        res.end(
          JSON.stringify({
            dirName,
            fileName: newFileName,
            sessionId: newSessionId,
            branchedFrom: originalId,
          })
        )
      } catch (err) {
        res.statusCode = 400
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Invalid request",
          })
        )
      }
    })
  })
}
