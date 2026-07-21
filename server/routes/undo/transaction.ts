import type { UseFn } from "../../http"
import type { IncomingMessage } from "node:http"
import { sendJson } from "../../http"
import { dirs, mkdir, readFile, unlink } from "../../helpers"
import { writeOwnerOnlyJson, writeOwnerOnlyText } from "../../atomicJsonFile"
import { rewindClaudeFiles } from "../../sdk-session"
import {
  commitFileOperations,
  prepareFileOperations,
  rollbackFileOperations,
  UndoOperationError,
} from "./fileOperations"
import { enqueueUndoMutation } from "./mutationQueue"
import { resolveUndoSessionPath, resolveUndoStatePath } from "./paths"
import type { UndoSessionMutation } from "../../../shared/contracts/undo"

const MAX_TRANSACTION_BODY_BYTES = 64 * 1024 * 1024

interface TransactionCheckpoint {
  sessionId: string
  userMessageId: string
  cwd: string
}

interface UndoTransactionRequest {
  operations: unknown
  session: {
    dirName: string
    fileName: string
    mutation: UndoSessionMutation
  }
  state: Record<string, unknown> & { sessionId: string }
  checkpoint?: TransactionCheckpoint
}

interface FileSnapshot {
  content: string
  existed: boolean
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && (
    (error as NodeJS.ErrnoException).code === "ENOENT"
    || error.message.includes("ENOENT")
  )
}

async function readSnapshot(filePath: string): Promise<FileSnapshot> {
  try {
    return { content: await readFile(filePath, "utf-8"), existed: true }
  } catch (error) {
    if (isMissingPathError(error)) return { content: "", existed: false }
    throw error
  }
}

async function restoreSnapshot(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (snapshot.existed) {
    await writeOwnerOnlyText(filePath, snapshot.content)
    return
  }
  try {
    await unlink(filePath)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function parseSessionMutation(value: unknown): UndoSessionMutation {
  if (!value || typeof value !== "object") {
    throw new UndoOperationError(400, "Valid session mutation is required")
  }
  const mutation = value as Partial<UndoSessionMutation>
  if (!isNonNegativeInteger(mutation.expectedLineCount)) {
    throw new UndoOperationError(400, "Valid expected session line count is required")
  }
  if (mutation.type === "truncate" && isNonNegativeInteger(mutation.keepLines)) {
    return mutation as UndoSessionMutation
  }
  if (
    mutation.type === "append"
    && Array.isArray(mutation.lines)
    && mutation.lines.every((line) => typeof line === "string")
  ) {
    return mutation as UndoSessionMutation
  }
  if (
    mutation.type === "splice"
    && isNonNegativeInteger(mutation.keepLines)
    && Array.isArray(mutation.lines)
    && mutation.lines.every((line) => typeof line === "string")
  ) {
    return mutation as UndoSessionMutation
  }
  throw new UndoOperationError(400, "Invalid session mutation")
}

function parseTransaction(value: unknown): UndoTransactionRequest {
  if (!value || typeof value !== "object") throw new UndoOperationError(400, "Invalid transaction")
  const request = value as Partial<UndoTransactionRequest>
  if (
    !request.session
    || typeof request.session.dirName !== "string"
    || typeof request.session.fileName !== "string"
  ) {
    throw new UndoOperationError(400, "Valid session target is required")
  }
  request.session.mutation = parseSessionMutation(request.session.mutation)
  if (!request.state || typeof request.state !== "object" || typeof request.state.sessionId !== "string") {
    throw new UndoOperationError(400, "Valid undo state is required")
  }
  if (request.checkpoint && (
    typeof request.checkpoint.sessionId !== "string"
    || typeof request.checkpoint.userMessageId !== "string"
    || typeof request.checkpoint.cwd !== "string"
    || request.checkpoint.sessionId !== request.state.sessionId
  )) {
    throw new UndoOperationError(400, "Invalid checkpoint request")
  }
  return request as UndoTransactionRequest
}

function applySessionMutation(content: string, mutation: UndoSessionMutation): string {
  const currentLines = content.split("\n").filter(Boolean)
  if (currentLines.length !== mutation.expectedLineCount) {
    throw new UndoOperationError(409, "Session changed while preparing undo; reload and retry")
  }
  if (mutation.type !== "append" && mutation.keepLines > currentLines.length) {
    throw new UndoOperationError(409, "Session mutation is beyond the current transcript")
  }
  const nextLines = mutation.type === "truncate"
    ? currentLines.slice(0, mutation.keepLines)
    : mutation.type === "append"
      ? [...currentLines, ...mutation.lines]
      : [...currentLines.slice(0, mutation.keepLines), ...mutation.lines]
  return nextLines.length > 0 ? `${nextLines.join("\n")}\n` : ""
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let body = ""
    let bytes = 0
    let settled = false
    req.setEncoding("utf8")
    req.on("data", (chunk: string) => {
      if (settled) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_TRANSACTION_BODY_BYTES) {
        settled = true
        reject(new UndoOperationError(413, "Undo transaction body is too large"))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on("end", () => {
      if (!settled) {
        settled = true
        resolve(body)
      }
    })
    req.on("error", (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

async function executeTransaction(request: UndoTransactionRequest): Promise<number> {
  const sessionPath = await resolveUndoSessionPath(request.session.dirName, request.session.fileName)
  const statePath = resolveUndoStatePath(request.state.sessionId)
  if (!sessionPath || !statePath) throw new UndoOperationError(403, "Access denied")

  const batch = await prepareFileOperations(request.operations, { allowEmpty: true })
  if (batch.touchedPaths.has(sessionPath) || batch.touchedPaths.has(statePath)) {
    throw new UndoOperationError(400, "File operations cannot target managed undo files")
  }

  let useCheckpoint = false
  if (request.checkpoint) {
    const preflight = await rewindClaudeFiles(
      request.checkpoint.sessionId,
      request.checkpoint.userMessageId,
      request.checkpoint.cwd,
      true,
    )
    useCheckpoint = preflight.canRewind === true
  }

  const sessionSnapshot = await readSnapshot(sessionPath)
  if (!sessionSnapshot.existed) throw new UndoOperationError(409, "Session file no longer exists")
  const nextSessionContent = applySessionMutation(sessionSnapshot.content, request.session.mutation)
  const stateSnapshot = await readSnapshot(statePath)
  await mkdir(dirs.UNDO_DIR, { recursive: true })

  let fileBatchStarted = false
  let sessionCommitted = false
  let stateCommitted = false
  try {
    if (!useCheckpoint) {
      fileBatchStarted = true
      await commitFileOperations(batch)
    }
    await writeOwnerOnlyText(sessionPath, nextSessionContent)
    sessionCommitted = true
    await writeOwnerOnlyJson(statePath, request.state)
    stateCommitted = true

    if (useCheckpoint && request.checkpoint) {
      // The native rewind may update only part of the project before failing.
      // Mark the prepared batch as started so its captured originals restore
      // every affected path if the checkpoint cannot complete atomically.
      fileBatchStarted = true
      const result = await rewindClaudeFiles(
        request.checkpoint.sessionId,
        request.checkpoint.userMessageId,
        request.checkpoint.cwd,
      )
      if (result.canRewind !== true) throw new Error("Claude checkpoint rewind was not applied")
    }
    return useCheckpoint ? 0 : batch.operationCount
  } catch (error) {
    const rollbackErrors: string[] = []
    if (sessionCommitted || stateCommitted || fileBatchStarted) {
      for (const [filePath, snapshot] of [
        [sessionPath, sessionSnapshot],
        [statePath, stateSnapshot],
      ] as const) {
        try {
          await restoreSnapshot(filePath, snapshot)
        } catch (rollbackError) {
          rollbackErrors.push(`${filePath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
    }
    if (fileBatchStarted) rollbackErrors.push(...await rollbackFileOperations(batch))
    const suffix = rollbackErrors.length > 0
      ? `; rollback incomplete: ${rollbackErrors.join("; ")}`
      : ""
    throw new UndoOperationError(409, `${error instanceof Error ? error.message : String(error)}${suffix}`)
  }
}

export function registerUndoTransactionRoute(use: UseFn): void {
  use("/api/undo/transaction", async (req, res, next) => {
    if (req.method !== "POST") return next()
    try {
      const body = await readBody(req)
      const request = parseTransaction(JSON.parse(body) as unknown)
      const applied = await enqueueUndoMutation(() => executeTransaction(request))
      sendJson(res, 200, { success: true, applied })
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(res, 400, { error: "Invalid JSON body" })
        return
      }
      const status = error instanceof UndoOperationError ? error.status : 500
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
    }
  })
}
