import type { UseFn } from "../helpers"
import { findJsonlPath, readFile, stat } from "../helpers"

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface FileChange {
  toolCallId: string
  type: "edit" | "write" | "deleted"
  filePath: string
  turnIndex: number
  isError: boolean
  content?: {
    oldString?: string
    newString?: string
    fileContent?: string
  }
}

export async function parseSessionFileChanges(
  jsonlContent: string,
  includeContent: boolean,
): Promise<{ changes: FileChange[]; cwd: string }> {
  const lines = jsonlContent.split("\n").filter(Boolean)

  let cwd = ""
  // Track which human-turn we're in (0-indexed)
  let lastHumanTurnIndex = 0
  let humanMessageCount = 0

  // toolCallId → FileChange (for Edit/Write)
  const changeMap = new Map<string, FileChange>()
  // toolCallId → error flag (populated from tool_result blocks)
  const resultMap = new Map<string, boolean>()
  // Bash rm paths: { path, turnIndex, isDir }
  const rmPaths: Array<{ path: string; turnIndex: number; isDir: boolean }> = []

  for (const line of lines) {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    if (obj.cwd && !cwd) cwd = obj.cwd as string

    if (obj.type === "user") {
      const content = (obj.message as Record<string, unknown>)?.content
      if (!Array.isArray(content)) continue

      // Distinguish human messages (contain text blocks) from tool_result messages
      const hasHumanText = content.some(
        (b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
      )

      if (hasHumanText) {
        lastHumanTurnIndex = humanMessageCount
        humanMessageCount++
      }

      // Collect tool results (error status)
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue
        const b = block as Record<string, unknown>
        if (b.type !== "tool_result") continue
        const toolId = b.tool_use_id as string
        if (toolId) resultMap.set(toolId, !!(b.is_error))
      }
    }

    if (obj.type === "assistant") {
      const content = (obj.message as Record<string, unknown>)?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (typeof block !== "object" || block === null) continue
        const b = block as ToolUseBlock
        if (b.type !== "tool_use") continue

        if (b.name === "Edit" || b.name === "Write") {
          const filePath = (b.input.file_path ?? b.input.path) as string
          if (!filePath) continue

          const change: FileChange = {
            toolCallId: b.id,
            type: b.name === "Edit" ? "edit" : "write",
            filePath,
            turnIndex: lastHumanTurnIndex,
            isError: false,
          }

          if (includeContent) {
            if (b.name === "Edit") {
              change.content = {
                oldString: b.input.old_string as string | undefined,
                newString: b.input.new_string as string | undefined,
              }
            } else {
              change.content = {
                fileContent: b.input.content as string | undefined,
              }
            }
          }

          changeMap.set(b.id, change)
        }

        if (b.name === "Bash") {
          const cmd = b.input.command as string | undefined
          if (!cmd || !/^(?:rm|git\s+rm)\s/.test(cmd)) continue
          const isDir = /-r\b/.test(cmd)
          // Quoted absolute paths
          for (const m of cmd.matchAll(/"(\/[^"]+)"/g)) {
            rmPaths.push({ path: m[1], turnIndex: lastHumanTurnIndex, isDir })
          }
          // Unquoted tokens that look like absolute paths
          const afterFlags = cmd.replace(/^(?:rm|git\s+rm)\s+(?:-[a-z]+\s+)*/i, "")
          for (const token of afterFlags.split(/\s+/)) {
            if (token.startsWith("/")) {
              rmPaths.push({ path: token, turnIndex: lastHumanTurnIndex, isDir })
            }
          }
        }
      }
    }
  }

  // Apply error status from tool results
  for (const [toolId, change] of changeMap) {
    const isError = resultMap.get(toolId)
    if (isError !== undefined) change.isError = isError
  }

  // Detect deleted files from rm commands (skip paths already in Edit/Write)
  const editWritePaths = new Set(Array.from(changeMap.values()).map((c) => c.filePath))
  const lastTurnForRm = new Map<string, number>()
  for (const rm of rmPaths) {
    const prev = lastTurnForRm.get(rm.path)
    if (prev === undefined || rm.turnIndex > prev) lastTurnForRm.set(rm.path, rm.turnIndex)
  }

  const deletedChanges: FileChange[] = []
  for (const [rmPath, rmTurnIndex] of lastTurnForRm) {
    if (editWritePaths.has(rmPath)) continue
    try {
      await stat(rmPath)
      // still exists — not actually deleted
    } catch {
      deletedChanges.push({
        toolCallId: `deleted:${rmPath}`,
        type: "deleted",
        filePath: rmPath,
        turnIndex: rmTurnIndex,
        isError: false,
      })
    }
  }

  const changes = [...Array.from(changeMap.values()), ...deletedChanges]
  changes.sort((a, b) => a.turnIndex - b.turnIndex || a.filePath.localeCompare(b.filePath))

  return { changes, cwd }
}

export function registerSessionFileChangesRoutes(use: UseFn) {
  use("/api/session-file-changes/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length === 0) return next()

    const sessionId = decodeURIComponent(parts[0])

    // GET /api/session-file-changes/:sessionId/tool/:toolCallId
    if (parts.length === 3 && parts[1] === "tool") {
      const toolCallId = decodeURIComponent(parts[2])
      try {
        const jsonlPath = await findJsonlPath(sessionId)
        if (!jsonlPath) {
          res.statusCode = 404
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Session not found" }))
          return
        }

        const jsonlContent = await readFile(jsonlPath, "utf-8")
        const { changes } = await parseSessionFileChanges(jsonlContent, true)

        const change = changes.find((c) => c.toolCallId === toolCallId)
        if (!change) {
          res.statusCode = 404
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Tool call not found" }))
          return
        }

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(change))
      } catch (err) {
        res.statusCode = 500
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: String(err) }))
      }
      return
    }

    // GET /api/session-file-changes/:sessionId[?content=true]
    if (parts.length === 1) {
      const includeContent = url.searchParams.get("content") === "true"
      try {
        const jsonlPath = await findJsonlPath(sessionId)
        if (!jsonlPath) {
          res.statusCode = 404
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Session not found" }))
          return
        }

        const jsonlContent = await readFile(jsonlPath, "utf-8")
        const { changes, cwd } = await parseSessionFileChanges(jsonlContent, includeContent)

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ sessionId, cwd, changes }))
      } catch (err) {
        res.statusCode = 500
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: String(err) }))
      }
      return
    }

    next()
  })
}
