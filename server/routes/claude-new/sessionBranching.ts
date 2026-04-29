import {
  CODEX_SESSIONS_DIR,
  dirs,
  dirname,
  formatCodexRolloutFileName,
  isCodexDirName,
  isWithinDir,
  mkdir,
  readFile,
  resolveSessionFilePath,
  writeFile,
  join,
  randomUUID,
} from "../../helpers"
import type { UseFn } from "../../helpers"

/**
 * Find the JSONL line index where the turn AFTER targetTurnIndex starts.
 * Returns null if targetTurnIndex >= total turns (keep everything).
 *
 * The `isTurnBoundary` predicate determines what counts as a turn start.
 * For Codex sessions, a preceding `turn_context` line is included in the
 * truncation point via look-back (stored in `pendingReturnIndex`).
 */
export function findTruncationLine(
  lines: string[],
  targetTurnIndex: number,
  isTurnBoundary: (obj: Record<string, unknown>) => boolean,
): number | null {
  let turnCount = 0
  let pendingReturnIndex: number | null = null

  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]) as Record<string, unknown>
      // track_context lines precede Codex user messages — include them in the cut
      if (obj.type === "turn_context") {
        pendingReturnIndex = i
        continue
      }
      if (isTurnBoundary(obj)) {
        if (turnCount === targetTurnIndex + 1) return pendingReturnIndex ?? i
        turnCount++
        pendingReturnIndex = null
      }
    } catch {
      /* skip malformed */
    }
  }
  return null
}

function isClaudeTurnBoundary(obj: Record<string, unknown>): boolean {
  if (obj.type !== "user" || obj.isMeta) return false
  const message = obj.message
  const content = (typeof message === "object" && message !== null)
    ? (message as Record<string, unknown>).content
    : undefined
  // Skip tool-result-only user messages
  return !(
    Array.isArray(content) &&
    content.every((b: unknown) => (b as Record<string, unknown>).type === "tool_result")
  )
}

function isCodexTurnBoundary(obj: Record<string, unknown>): boolean {
  const payload = obj.payload as Record<string, unknown> | undefined
  return (
    obj.type === "event_msg" &&
    payload?.type === "user_message" &&
    typeof payload.message === "string"
  )
}

export function registerBranchSessionRoute(use: UseFn) {
  use("/api/branch-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { dirName, fileName, turnIndex } = JSON.parse(body)

        if (!dirName || !fileName) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: "dirName and fileName are required" }))
          return
        }

        const sourcePath = await resolveSessionFilePath(dirName, fileName)
        if (!sourcePath || (!isCodexDirName(dirName) && !isWithinDir(dirs.PROJECTS_DIR, sourcePath))) {
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

        if (turnIndex != null) {
          const boundary = isCodexDirName(dirName) ? isCodexTurnBoundary : isClaudeTurnBoundary
          const truncLine = findTruncationLine(lines, turnIndex, boundary)
          if (truncLine !== null) {
            lines = lines.slice(0, truncLine)
          }
        }

        const firstObj = JSON.parse(lines[0])
        const newSessionId = randomUUID()
        let originalId = ""
        let newFileName = `${newSessionId}.jsonl`
        let newPath = join(dirs.PROJECTS_DIR, dirName, newFileName)

        if (isCodexDirName(dirName)) {
          originalId = firstObj?.payload?.id || ""
          firstObj.payload.id = newSessionId
          firstObj.payload.branchedFrom = {
            sessionId: originalId,
            turnIndex: turnIndex ?? null,
          }
          lines[0] = JSON.stringify(firstObj)

          const relativeName = formatCodexRolloutFileName(newSessionId)
          newFileName = relativeName
          newPath = join(CODEX_SESSIONS_DIR, relativeName)
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
