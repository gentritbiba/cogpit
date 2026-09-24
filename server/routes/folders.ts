import type { IncomingMessage, ServerResponse } from "node:http"
import type { CreatedFolder } from "../../shared/contracts/folders"
import { isRecord } from "../../shared/objects"
import { getProjectsRoot } from "../config"
import { mayActHostWide, reportAuthEvent } from "../edition"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { absoluteFolderPath, createFolder, listFolder } from "../lib/folders"
import { ErrorCodes, RouteError, sendError } from "../lib/routeError"

function sendFailure(res: ServerResponse, error: unknown): void {
  sendError(res, error instanceof RouteError
    ? error
    : new RouteError(500, ErrorCodes.INTERNAL_ERROR, error instanceof Error ? error.message : "Folder request failed"))
}

/** The highest folder the caller may browse: none for whoever acts host-wide, else the projects root. */
function topFor(req: IncomingMessage): string | null {
  return mayActHostWide(req) ? null : getProjectsRoot()
}

/** GET /api/folders?path=<absolute>: its subfolders; no path lists the projects root. */
async function listRequested(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requested = new URL(req.url || "/", "http://localhost").searchParams.get("path")
  try {
    const path = requested ? absoluteFolderPath(requested, "path") : getProjectsRoot()
    sendJson(res, 200, await listFolder(path, topFor(req)))
  } catch (error) {
    sendFailure(res, error)
  }
}

/** POST /api/folders { parent, name }: one new folder, recorded like any other change to the host. */
function createRequested(req: IncomingMessage, res: ServerResponse): void {
  withJsonBody<unknown>(req, res, async (body) => {
    const { parent, name } = isRecord(body) ? body : {}
    try {
      if (typeof name !== "string") throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "name must be a string")
      const path = await createFolder(absoluteFolderPath(parent, "parent"), name, topFor(req))
      reportAuthEvent(req, "folder.create", { path })
      sendJson(res, 201, { path } satisfies CreatedFolder)
    } catch (error) {
      sendFailure(res, error)
    }
  })
}

/**
 * The folder browser a remote client picks a new session's folder with. Anyone
 * who may start a session may use it; only whoever acts host-wide may leave the
 * projects root, so other accounts never see the host's folders beyond it.
 */
export function registerFolderRoutes(use: UseFn) {
  use("/api/folders", (req, res, next) => {
    // Mounted as a prefix; only the path itself is served here.
    const rest = (req.url || "/").split("?")[0]
    if (rest !== "/" && rest !== "") return next()
    if (req.method === "GET") return listRequested(req, res)
    if (req.method === "POST") return createRequested(req, res)
    next()
  })
}
