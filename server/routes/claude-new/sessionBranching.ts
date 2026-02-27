import {
  dirs,
  isWithinDir,
  readFile,
  writeFile,
  join,
  randomUUID,
} from "../../helpers"
import type { UseFn } from "../../helpers"

/**
 * Find the JSONL line index where the turn AFTER targetTurnIndex starts.
 * Returns null if targetTurnIndex >= total turns (keep everything).
 */
export function findTruncationLine(
  lines: string[],
  targetTurnIndex: number
): number | null {
  let turnCount = 0
  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i])
      if (obj.type === "user" && !obj.isMeta) {
        const content = obj.message?.content
        // Skip tool-result-only user messages
        if (
          Array.isArray(content) &&
          content.every((b: { type: string }) => b.type === "tool_result")
        ) {
          continue
        }
        if (turnCount === targetTurnIndex + 1) return i
        turnCount++
      }
    } catch {
      /* skip malformed */
    }
  }
  return null
}

/**
 * Register the POST /api/branch-session route.
 */
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

        const sourcePath = join(dirs.PROJECTS_DIR, dirName, fileName)
        if (!isWithinDir(dirs.PROJECTS_DIR, sourcePath)) {
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

        // If turnIndex is provided, truncate lines after that turn
        if (turnIndex != null) {
          const truncLine = findTruncationLine(lines, turnIndex)
          if (truncLine !== null) {
            lines = lines.slice(0, truncLine)
          }
          // If truncLine is null, turnIndex >= total turns — keep everything
        }

        // Rewrite first line with new sessionId and branchedFrom
        const firstObj = JSON.parse(lines[0])
        const originalId = firstObj.sessionId || ""
        const newSessionId = randomUUID()
        firstObj.sessionId = newSessionId
        firstObj.branchedFrom = {
          sessionId: originalId,
          turnIndex: turnIndex ?? null,
        }
        lines[0] = JSON.stringify(firstObj)

        const newFileName = `${newSessionId}.jsonl`
        const newPath = join(dirs.PROJECTS_DIR, dirName, newFileName)
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
