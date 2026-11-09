import {
  dirname,
  mkdir,
  stat,
  writeFile,
  randomUUID,
} from "../../helpers"
import { descriptorForDirName } from "../../../shared/session/agent-descriptors"
import {
  cutLineAfterTurnIndex,
  findTurnById,
  formatFor,
  type AgentFormat,
} from "../../../shared/session/agents"
import { storeForDirName, storeForPath } from "../../agents"
import { runtimeForDirName } from "../../agents/runtimes"
import { readTranscriptText } from "../../agents/transcriptFile"
import { sendJson, withJsonBody, type UseFn } from "../../http"
import { reportSessionEvent, recordSessionOwner } from "../../edition"
import { authorizeTranscript } from "../../edition/transcript"

const TURN_NOT_FOUND = "Unable to locate the selected turn in the current session file"

/**
 * The turn the client named, in file order, and the line to cut at after it
 * (null keeps everything). An id is exact however much of the session the
 * client had loaded; an index counts only the loaded turns, so it stands alone
 * only for a client that sent no id. Null when the named turn is not in the file.
 */
function branchPoint(
  format: AgentFormat,
  lines: readonly string[],
  turnIndex: number | undefined,
  turnId: string | undefined,
): { turnIndex: number | null; cutLine: number | null } | null {
  if (turnId) {
    const turn = findTurnById(format, lines, turnId)
    return turn && { turnIndex: turn.index, cutLine: turn.nextLine }
  }
  if (turnIndex == null) return { turnIndex: null, cutLine: null }
  return { turnIndex, cutLine: cutLineAfterTurnIndex(format, lines, turnIndex) }
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
          sendJson(res, 400, { error: "dirName and fileName are required" })
          return
        }

        const source = await authorizeTranscript(req, res, { dirName, fileName }, "view")
        if (source === null) return
        const sourcePath = source.filePath
        const descriptor = descriptorForDirName(dirName)
        // The resolved path has to sit in the storage of the agent the dirName
        // claims, so one agent's dirName cannot reach another's transcript.
        if (!sourcePath || storeForPath(sourcePath)?.kind !== descriptor.kind) {
          sendJson(res, 403, { error: "Access denied" })
          return
        }
        // Whoever branches owns the copy, whoever owns the source.
        const recordBranch = (sessionId: string) => {
          recordSessionOwner(req, sessionId, descriptor.kind)
          reportSessionEvent(req, "session.branch", { sessionId, agent: descriptor.kind, dirName }, { branchedFrom: source.sessionId })
        }

        const content = await readTranscriptText(sourcePath)
        let lines = content.split("\n").filter(Boolean)

        if (lines.length === 0) {
          sendJson(res, 400, { error: "Source session is empty" })
          return
        }

        const format = formatFor(descriptor.kind)
        const point = branchPoint(format, lines, turnIndex, turnUuid)
        if (!point) {
          sendJson(res, 409, { error: TURN_NOT_FOUND })
          return
        }

        if (descriptor.capabilities.nativeFork) {
          // The CLI forks its own session; the transcript is never copied.
          const originalId = source.transcriptSessionId
          if (!originalId) {
            sendJson(res, 400, { error: `Invalid ${descriptor.displayName} session path` })
            return
          }
          const forked = await runtimeForDirName(dirName).fork(originalId, { lines, cutLine: point.cutLine })
          recordBranch(forked.sessionId)
          sendJson(res, 200, {
            dirName,
            fileName: forked.fileName,
            sessionId: forked.sessionId,
            branchedFrom: originalId,
          })
          return
        }

        if (point.cutLine !== null) lines = lines.slice(0, point.cutLine)

        const newSessionId = randomUUID()
        const { record, originalId } = format.brandBranch(
          JSON.parse(lines[0]) as Record<string, unknown>,
          newSessionId,
          point.turnIndex,
          Date.now(),
        )
        lines[0] = JSON.stringify(record)

        const target = storeForDirName(dirName).transcriptPath(dirName, newSessionId)
        if (!target) {
          sendJson(res, 500, { error: `${descriptor.displayName} has no session storage` })
          return
        }
        await mkdir(dirname(target.filePath), { recursive: true })
        // The copy is no more readable than the transcript it came from.
        const { mode } = await stat(sourcePath)
        await writeFile(target.filePath, lines.join("\n") + "\n", { mode: mode & 0o777 })
        recordBranch(newSessionId)

        sendJson(res, 200, {
          dirName,
          fileName: target.fileName,
          sessionId: newSessionId,
          branchedFrom: originalId,
        })
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "Invalid request" })
      }
    })
  })
}
