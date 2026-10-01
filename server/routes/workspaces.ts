import { createReadStream } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { pipeline } from "node:stream/promises"
import {
  WORKSPACE_BUNDLE_REF_HEADER,
  WORKSPACE_UPLOAD_CHUNK_BYTES,
  type WorkspaceExportResponse,
  type WorkspaceImportResponse,
  type WorkspaceProbeResponse,
  type WorkspaceUploadCreated,
  type WorkspaceUploadProgress,
} from "../../shared/contracts/workspaces"
import { HttpBodyError, MAX_REQUEST_BODY_BYTES, readBinaryBody, readJsonBody, sendJson, type UseFn } from "../http"
import { ErrorCodes, RouteError, sendError } from "../lib/routeError"
import {
  exportWorkspace,
  importWorkspace,
  knownCommits,
  removeWorkspace,
  type ImportedWorkspace,
} from "../workspaceTransfer/deviceStore"
import { COMMIT_SHA_RE } from "../workspaceTransfer/snapshot"
import {
  appendUpload,
  createUpload,
  deleteDownload,
  deleteUpload,
  stageDownload,
  stagedDownload,
  sweepExpiredTransfers,
  uploadedBundlePath,
} from "../workspaceTransfer/transfers"

const MAX_EXCLUDED_COMMITS = 50_000
const REQUEST_ID_RE = /^[a-zA-Z0-9_:-]{8,160}$/
const IMPORT_MEMORY_MS = 60 * 60_000
const SWEEP_INTERVAL_MS = 60_000
let lastSweep = 0

function invalid(message: string): RouteError {
  return new RouteError(400, ErrorCodes.INVALID_REQUEST, message)
}

function asRouteError(error: unknown): unknown {
  return error instanceof HttpBodyError ? new RouteError(error.statusCode, ErrorCodes.INVALID_REQUEST, error.message) : error
}

async function readObject(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req, { maxBytes }).catch((error: unknown) => { throw asRouteError(error) })
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Request body must be a JSON object")
  return body as Record<string, unknown>
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== "string") throw invalid(`${field} must be a string`)
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  return body[field] === undefined || body[field] === null ? null : requireString(body, field)
}

async function readChunk(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers["content-length"]) > WORKSPACE_UPLOAD_CHUNK_BYTES) {
    throw new RouteError(413, ErrorCodes.INVALID_REQUEST, "Chunk too large")
  }
  return readBinaryBody(req, { maxBytes: WORKSPACE_UPLOAD_CHUNK_BYTES, tooLargeMessage: "Chunk too large" })
    .catch((error: unknown) => { throw asRouteError(error) })
}

async function handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readObject(req)
  const response: WorkspaceProbeResponse = { commits: await knownCommits(requireString(body, "repoKey")) }
  sendJson(res, 200, response)
}

async function handleAppend(req: IncomingMessage, res: ServerResponse, uploadId: string, url: URL): Promise<void> {
  const offsetParam = url.searchParams.get("offset") ?? ""
  const offset = Number(offsetParam)
  if (!/^\d+$/.test(offsetParam) || !Number.isSafeInteger(offset)) throw invalid("offset must be a non-negative integer")
  const result = await appendUpload(uploadId, offset, await readChunk(req))
  const status = result.status === "stored" ? 200 : result.status === "offset-mismatch" ? 409 : 413
  sendJson(res, status, { size: result.size } satisfies WorkspaceUploadProgress)
}

/**
 * Imports by the hub's request id, so a hub retrying an import whose answer it
 * lost gets the same workspace instead of a second one. A failed import is
 * forgotten and can be retried.
 */
const importsByRequest = new Map<string, { at: number; result: Promise<ImportedWorkspace> }>()

async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readObject(req)
  const uploadId = optionalString(body, "uploadId")
  const bundleRef = optionalString(body, "bundleRef")
  const requestId = optionalString(body, "requestId")
  if (uploadId && !bundleRef) throw invalid("bundleRef is required with uploadId")
  if (requestId !== null && !REQUEST_ID_RE.test(requestId)) throw invalid("requestId is malformed")

  const now = Date.now()
  for (const [key, { at }] of importsByRequest) if (now - at > IMPORT_MEMORY_MS) importsByRequest.delete(key)
  const earlier = requestId ? importsByRequest.get(requestId) : undefined
  if (earlier) {
    sendJson(res, 200, await earlier.result satisfies WorkspaceImportResponse)
    return
  }
  const result = (async () => importWorkspace({
    repoKey: requireString(body, "repoKey"),
    bundlePath: uploadId ? await uploadedBundlePath(uploadId) : null,
    bundleRef,
    snapshot: requireString(body, "snapshot"),
    task: requireString(body, "task"),
    subdir: requireString(body, "subdir"),
  }))()
  if (requestId) importsByRequest.set(requestId, { at: now, result })
  let imported: ImportedWorkspace
  try {
    imported = await result
  } catch (error) {
    if (requestId) importsByRequest.delete(requestId)
    throw error
  }
  // Kept when the import fails, so the caller can retry without re-uploading.
  if (uploadId) await deleteUpload(uploadId)
  sendJson(res, 200, imported satisfies WorkspaceImportResponse)
}

async function handleRemove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await removeWorkspace(requireString(await readObject(req), "workspaceId"))
  sendJson(res, 200, { removed: true })
}

async function handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readObject(req, MAX_REQUEST_BODY_BYTES)
  const { exclude } = body
  if (
    !Array.isArray(exclude)
    || exclude.length > MAX_EXCLUDED_COMMITS
    || !exclude.every((sha): sha is string => typeof sha === "string" && COMMIT_SHA_RE.test(sha))
  ) {
    throw invalid("exclude must be an array of commit shas")
  }
  const exported = await exportWorkspace(requireString(body, "workspaceId"), exclude)
  const response: WorkspaceExportResponse = {
    tip: exported.tip,
    dirty: exported.dirty,
    downloadId: exported.bundle ? await stageDownload(exported.bundle) : null,
  }
  sendJson(res, 200, response)
}

async function handleDownload(res: ServerResponse, downloadId: string): Promise<void> {
  const download = await stagedDownload(downloadId)
  if (!download) throw new RouteError(404, ErrorCodes.NOT_FOUND, "Download not found or expired")
  res.statusCode = 200
  res.setHeader("Content-Type", "application/octet-stream")
  res.setHeader("Content-Length", String(download.size))
  res.setHeader(WORKSPACE_BUNDLE_REF_HEADER, download.ref)
  res.setHeader("Cache-Control", "no-store")
  // An interrupted download keeps its file, so the caller can retry until it expires.
  res.once("finish", () => void deleteDownload(downloadId))
  await pipeline(createReadStream(download.path), res).catch(() => undefined)
}

/**
 * Device side of handing a task to another machine: a hub uploads a bundle of
 * its repository in chunks, imports it as a worktree here, and later exports
 * the worktree's result back as a bundle.
 */
export function registerWorkspaceRoutes(use: UseFn) {
  // Files an earlier run left behind go now, not on the first request.
  void sweepExpiredTransfers().catch(() => undefined)
  lastSweep = Date.now()
  use("/api/workspaces", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    const [resource, id, ...extra] = url.pathname.split("/").filter(Boolean)
    const method = req.method ?? "GET"

    try {
      if (Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
        lastSweep = Date.now()
        await sweepExpiredTransfers()
      }
      if (extra.length > 0) return next()

      if (method === "POST" && resource === "probe" && !id) return await handleProbe(req, res)
      if (method === "POST" && resource === "uploads" && !id) {
        const uploadId = await createUpload()
        if (!uploadId) throw new RouteError(429, ErrorCodes.CONFLICT, "Too many uploads in progress; try again shortly")
        sendJson(res, 200, { uploadId } satisfies WorkspaceUploadCreated)
        return
      }
      if (method === "PUT" && resource === "uploads" && id) return await handleAppend(req, res, id, url)
      if (method === "POST" && resource === "import" && !id) return await handleImport(req, res)
      if (method === "POST" && resource === "export" && !id) return await handleExport(req, res)
      if (method === "POST" && resource === "remove" && !id) return await handleRemove(req, res)
      if (method === "GET" && resource === "downloads" && id) return await handleDownload(res, id)
      return next()
    } catch (error) {
      if (error instanceof RouteError) return sendError(res, error)
      sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : String(error)))
    }
  })
}
