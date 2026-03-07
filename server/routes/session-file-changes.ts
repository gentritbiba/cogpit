import type { UseFn } from "../helpers"
import { findJsonlPath, readFile, sendJson, stat } from "../helpers"
import type { ToolUseBlock } from "../../src/lib/types"
import { computeNetDiff, type EditOp } from "../../src/lib/diffUtils"

export interface ComputedFileChange {
  filePath: string
  type: "edit" | "write" | "deleted"
  additions: number
  deletions: number
  hasEdit: boolean
  hasWrite: boolean
  isError: boolean
  toolCallIds: string[]
  turnIndex: number
  content?: {
    originalStr: string
    currentStr: string
  }
}

export async function parseSessionFileChanges(
  jsonlContent: string,
  includeContent: boolean,
): Promise<{ changes: ComputedFileChange[]; cwd: string }> {
  const lines = jsonlContent.split("\n").filter(Boolean)

  let cwd = ""
  let lastHumanTurnIndex = 0
  let humanMessageCount = 0

  // Per-file accumulator
  interface FileAccum {
    toolCallIds: string[]
    hasEdit: boolean
    hasWrite: boolean
    isError: boolean
    firstTurnIndex: number
    ops: EditOp[]
  }

  const fileMap = new Map<string, FileAccum>()

  // toolCallId → { filePath, isEdit, oldString, newString }
  const toolCallDetails = new Map<string, { filePath: string; isEdit: boolean; oldString: string; newString: string }>()
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

      const hasHumanText = content.some(
        (b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
      )

      if (hasHumanText) {
        lastHumanTurnIndex = humanMessageCount
        humanMessageCount++
      }

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

          const isEdit = b.name === "Edit"
          const oldString = isEdit ? String(b.input.old_string ?? "") : ""
          const newString = isEdit
            ? String(b.input.new_string ?? "")
            : String(b.input.content ?? "")

          toolCallDetails.set(b.id, { filePath, isEdit, oldString, newString })

          let accum = fileMap.get(filePath)
          if (!accum) {
            accum = {
              toolCallIds: [],
              hasEdit: false,
              hasWrite: false,
              isError: false,
              firstTurnIndex: lastHumanTurnIndex,
              ops: [],
            }
            fileMap.set(filePath, accum)
          }

          accum.toolCallIds.push(b.id)
          if (isEdit) accum.hasEdit = true
          else accum.hasWrite = true
          accum.ops.push({ oldString, newString, isWrite: !isEdit })
        }

        if (b.name === "Bash") {
          const cmd = b.input.command as string | undefined
          if (!cmd || !/^(?:rm|git\s+rm)\s/.test(cmd)) continue
          const isDir = /-r\b/.test(cmd)
          for (const m of cmd.matchAll(/"(\/[^"]+)"/g)) {
            rmPaths.push({ path: m[1], turnIndex: lastHumanTurnIndex, isDir })
          }
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
  for (const [toolId, details] of toolCallDetails) {
    const isError = resultMap.get(toolId)
    if (isError) {
      const accum = fileMap.get(details.filePath)
      if (accum) accum.isError = true
    }
  }

  // Build computed changes
  const changes: ComputedFileChange[] = []

  for (const [filePath, accum] of fileMap) {
    const diff = computeNetDiff(accum.ops)
    const type: "edit" | "write" = accum.hasWrite && !accum.hasEdit ? "write" : "edit"

    const change: ComputedFileChange = {
      filePath,
      type,
      additions: diff.addCount,
      deletions: diff.delCount,
      hasEdit: accum.hasEdit,
      hasWrite: accum.hasWrite,
      isError: accum.isError,
      toolCallIds: accum.toolCallIds,
      turnIndex: accum.firstTurnIndex,
    }

    if (includeContent) {
      change.content = {
        originalStr: diff.originalStr,
        currentStr: diff.currentStr,
      }
    }

    changes.push(change)
  }

  // Detect deleted files from rm commands
  const editWritePaths = new Set(fileMap.keys())
  const lastTurnForRm = new Map<string, number>()
  for (const rm of rmPaths) {
    const prev = lastTurnForRm.get(rm.path)
    if (prev === undefined || rm.turnIndex > prev) lastTurnForRm.set(rm.path, rm.turnIndex)
  }

  for (const [rmPath, rmTurnIndex] of lastTurnForRm) {
    if (editWritePaths.has(rmPath)) continue
    try {
      await stat(rmPath)
    } catch {
      changes.push({
        filePath: rmPath,
        type: "deleted",
        additions: 0,
        deletions: 0,
        hasEdit: false,
        hasWrite: false,
        isError: false,
        toolCallIds: [`deleted:${rmPath}`],
        turnIndex: rmTurnIndex,
      })
    }
  }

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
        if (!jsonlPath) return sendJson(res, 404, { error: "Session not found" })

        const jsonlContent = await readFile(jsonlPath, "utf-8")
        const { changes } = await parseSessionFileChanges(jsonlContent, true)

        const change = changes.find((c) => c.toolCallIds.includes(toolCallId))
        if (!change) return sendJson(res, 404, { error: "Tool call not found" })

        sendJson(res, 200, change)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    // GET /api/session-file-changes/:sessionId[?content=true]
    if (parts.length === 1) {
      const includeContent = url.searchParams.get("content") === "true"
      try {
        const jsonlPath = await findJsonlPath(sessionId)
        if (!jsonlPath) return sendJson(res, 404, { error: "Session not found" })

        const jsonlContent = await readFile(jsonlPath, "utf-8")
        const { changes, cwd } = await parseSessionFileChanges(jsonlContent, includeContent)

        sendJson(res, 200, { sessionId, cwd, changes })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    next()
  })
}
