import type { IncomingMessage, ServerResponse } from "node:http"
import { sendJson, type UseFn } from "../../http"
import { storeForDirName, storeForPath } from "../../agents"
import { authorizeSession, visibilityFor } from "../../edition"
import { authorizeTranscript, visibleChildTranscripts } from "../../edition/transcript"
import { findJsonlPath } from "../../sessionPaths"
import { handleActiveSessions } from "./activeSessionsRoute"
import { listProjects } from "./projectList"
import { handleSessionPage } from "./sessionPage"
import { serveTranscript } from "./transcriptPages"

/** GET /api/sessions/{dirName}/{sessionId}/subagents — a session's sub-agent transcripts the caller may see. */
async function handleSubagentList(
  req: IncomingMessage,
  res: ServerResponse,
  dirName: string,
  sessionId: string,
): Promise<void> {
  const session = await authorizeSession(req, res, { sessionId }, "view")
  if (session === null) return
  const listing = await storeForDirName(dirName).listSubagentFiles(dirName, session.sessionId)
  if (!listing) {
    sendJson(res, 403, { error: "Access denied" })
    return
  }
  sendJson(res, 200, await visibleChildTranscripts(req, dirName)(listing))
}

/** GET /api/sessions/{dirName}/{fileName} — a transcript, nested paths (sub-agents) included. */
async function handleTranscript(
  req: IncomingMessage,
  res: ServerResponse,
  dirName: string,
  fileName: string,
  params: URLSearchParams,
): Promise<void> {
  if (!fileName.endsWith(".jsonl")) {
    sendJson(res, 400, { error: "Only .jsonl files" })
    return
  }
  const transcript = await authorizeTranscript(req, res, { dirName, fileName }, "view")
  if (transcript === null) return
  if (transcript.filePath === null) {
    sendJson(res, 403, { error: "Access denied" })
    return
  }
  await serveTranscript(res, transcript.filePath, params)
}

export function registerProjectRoutes(use: UseFn) {
  // GET /api/projects - list all projects
  use("/api/projects", async (req, res, next) => {
    if (req.method !== "GET") return next()
    if (req.url && req.url !== "/" && req.url !== "") return next()

    try {
      sendJson(res, 200, await listProjects(visibilityFor(req)))
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })

  // GET /api/sessions/:dirName - list sessions / serve file content
  use("/api/sessions/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)

    if (parts.length === 1) {
      await handleSessionPage(req, res, parts[0], url.searchParams)
    } else if (parts.length === 3 && parts[2] === "subagents") {
      await handleSubagentList(req, res, parts[0], parts[1])
    } else if (parts.length >= 2) {
      await handleTranscript(req, res, parts[0], parts.slice(1).join("/"), url.searchParams)
    } else {
      next()
    }
  })

  // GET /api/active-sessions - list most recent sessions across all projects
  use("/api/active-sessions", handleActiveSessions)

  // GET /api/find-session/:sessionId - find a session JSONL file by its session ID
  use("/api/find-session/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const session = await authorizeSession(req, res, { sessionId: decodeURIComponent(parts[0]) }, "view")
    if (session === null) return
    try {
      const filePath = await findJsonlPath(session.sessionId)
      const address = filePath ? await storeForPath(filePath)?.sessionAddress(filePath) : null
      if (address) {
        sendJson(res, 200, address)
        return
      }
      sendJson(res, 404, { error: "Session not found" })
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
