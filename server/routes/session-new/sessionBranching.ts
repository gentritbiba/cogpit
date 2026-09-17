import {
  dirname,
  mkdir,
  readFile,
  writeFile,
  randomUUID,
} from "../../helpers"
import { descriptorForDirName } from "../../../shared/session/agent-descriptors"
import {
  cutLineAfterTurnIndex,
  cutLineAfterTurnId,
  formatFor,
  type AgentFormat,
} from "../../../shared/session/agents"
import { storeForDirName, storeForPath } from "../../agents"
import { runtimeForDirName } from "../../agents/runtimes"
import { resolveSessionFilePath } from "../../sessionPaths"
import { sendJson, withJsonBody, type UseFn } from "../../http"

/**
 * Prefer the turn-id cut — exact regardless of how much of the session the
 * client had loaded. Fall back to the index cut when the id is absent or
 * unmatched (an agent may leave a turn unlabelled). Null keeps everything.
 */
function branchCutLine(
  format: AgentFormat,
  lines: readonly string[],
  turnIndex: number | undefined,
  turnId: string | undefined,
): number | null {
  if (turnId) {
    const byId = cutLineAfterTurnId(format, lines, turnId)
    if (byId !== null) return byId === "keep-all" ? null : byId
  }
  return turnIndex != null ? cutLineAfterTurnIndex(format, lines, turnIndex) : null
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

        const sourcePath = await resolveSessionFilePath(dirName, fileName)
        const descriptor = descriptorForDirName(dirName)
        // The resolved path has to sit in the storage of the agent the dirName
        // claims, so one agent's dirName cannot reach another's transcript.
        if (!sourcePath || storeForPath(sourcePath)?.kind !== descriptor.kind) {
          sendJson(res, 403, { error: "Access denied" })
          return
        }

        const content = await readFile(sourcePath, "utf-8")
        let lines = content.split("\n").filter(Boolean)

        if (lines.length === 0) {
          sendJson(res, 400, { error: "Source session is empty" })
          return
        }

        if (descriptor.capabilities.nativeFork) {
          // The CLI forks its own session; the transcript is never copied.
          const originalId = descriptor.sessionFile.sessionId(fileName)
          if (!originalId) {
            sendJson(res, 400, { error: `Invalid ${descriptor.displayName} session path` })
            return
          }
          const forked = await runtimeForDirName(dirName).fork(originalId, { lines, turnIndex, turnUuid })
          sendJson(res, 200, {
            dirName,
            fileName: forked.fileName,
            sessionId: forked.sessionId,
            branchedFrom: originalId,
          })
          return
        }

        const format = formatFor(descriptor.kind)
        const truncLine = branchCutLine(format, lines, turnIndex, turnUuid)
        if (truncLine !== null) lines = lines.slice(0, truncLine)

        const newSessionId = randomUUID()
        const { record, originalId } = format.brandBranch(
          JSON.parse(lines[0]) as Record<string, unknown>,
          newSessionId,
          turnIndex ?? null,
        )
        lines[0] = JSON.stringify(record)

        const target = storeForDirName(dirName).transcriptPath(dirName, newSessionId)
        if (!target) {
          sendJson(res, 500, { error: `${descriptor.displayName} has no session storage` })
          return
        }
        await mkdir(dirname(target.filePath), { recursive: true })
        await writeFile(target.filePath, lines.join("\n") + "\n")

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
