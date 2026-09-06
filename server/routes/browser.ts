/**
 * The managed browsers as REST: status for the panel, the named-browser CRUD
 * behind its session bar, launch/stop, and the one-shot skill install for
 * agents Cogpit does not spawn. The `/__browser` socket owns the live page;
 * this owns the list.
 *
 * Every name arrives as a URL segment, so it is decoded once here and then
 * validated by the same asserts the registry and the daemons use — the route
 * never builds a path from one itself.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import { MAX_URL_LENGTH } from "../../shared/browser/protocol"
import { resolveNavigationUrl } from "../../shared/browser/url"
import type { BrowserSessionInfo, BrowserStatus } from "../../shared/browser/types"
import { AGENT_KINDS, descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"
import { isRunning, launch, stop } from "../browser/daemons"
import { assertNamedBrowser, BrowserNameError, DEFAULT_BROWSER } from "../browser/paths"
import {
  BrowserExistsError,
  BrowserNotFoundError,
  createBrowser,
  listBrowsers,
  readBrowser,
  removeBrowser,
  updateBrowser,
  type BrowserPatch,
} from "../browser/registry"
import { findRealAgentBrowser } from "../browser/shim"
import { installSkill } from "../browser/skill"
import { HttpBodyError, readJsonBody, sendJson, type UseFn, type NextFn } from "../http"

type RunningProbe = (name: string) => Promise<boolean>

export interface BrowserRouteDeps {
  binaryPath: () => string | null
  listBrowsers: (isRunning: RunningProbe) => Promise<BrowserSessionInfo[]>
  readBrowser: (name: string, isRunning: RunningProbe) => Promise<BrowserSessionInfo>
  createBrowser: (name: string, note?: string) => BrowserSessionInfo
  updateBrowser: (name: string, patch: BrowserPatch) => void
  removeBrowser: (name: string) => void
  isRunning: RunningProbe
  launch: (name: string, url: string) => Promise<void>
  stop: (name: string) => Promise<void>
  installSkill: (target: AgentKind) => string
}

export const defaultBrowserRouteDeps: BrowserRouteDeps = {
  binaryPath: () => findRealAgentBrowser(),
  listBrowsers: (running) => listBrowsers(running),
  readBrowser: (name, running) => readBrowser(name, running),
  createBrowser: (name, note) => createBrowser(name, note),
  updateBrowser: (name, patch) => {
    updateBrowser(name, patch)
  },
  removeBrowser: (name) => removeBrowser(name),
  isRunning: (name) => isRunning(name),
  launch: (name, url) => launch(name, url),
  stop: (name) => stop(name),
  installSkill: (target) => installSkill(target),
}

const BLANK_URL = "about:blank"

/** The CLIs whose config root has a skills directory to install into. */
const SKILL_TARGETS: readonly AgentKind[] = AGENT_KINDS.filter(
  (kind) => descriptorFor(kind).config.skillsDir !== null,
)

function subPath(rawUrl: string): string {
  const path = rawUrl.split("?")[0] || "/"
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
}

function browserName(segment: string): string {
  let name: string
  try {
    name = decodeURIComponent(segment)
  } catch {
    throw new BrowserNameError(`Browser name ${JSON.stringify(segment)} is not valid percent-encoding`)
  }
  assertNamedBrowser(name)
  return name
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody<unknown>(req, { allowEmpty: true })
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpBodyError("Invalid JSON body", 400)
  }
  return body as Record<string, unknown>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function sendStatus(res: ServerResponse, deps: BrowserRouteDeps): Promise<void> {
  const binaryPath = deps.binaryPath()
  const status: BrowserStatus = {
    installed: binaryPath !== null,
    binaryPath,
    sessions: await deps.listBrowsers(deps.isRunning),
  }
  sendJson(res, 200, status)
}

function createSession(body: Record<string, unknown>, res: ServerResponse, deps: BrowserRouteDeps): void {
  const { name, note } = body
  if (typeof name !== "string") {
    sendJson(res, 400, { error: "name is required" })
    return
  }
  sendJson(res, 201, deps.createBrowser(name, typeof note === "string" ? note : undefined))
}

async function patchSession(
  name: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  deps: BrowserRouteDeps,
): Promise<void> {
  const patch: BrowserPatch = {}
  if (body.note === null) patch.note = null
  else if (typeof body.note === "string") patch.note = body.note
  deps.updateBrowser(name, patch)
  sendJson(res, 200, await deps.readBrowser(name, deps.isRunning))
}

async function deleteSession(name: string, res: ServerResponse, deps: BrowserRouteDeps): Promise<void> {
  if (name === DEFAULT_BROWSER) {
    sendJson(res, 400, { error: `The ${DEFAULT_BROWSER} browser cannot be removed` })
    return
  }
  // Stop first: removeBrowser deletes the profile directory, and a live
  // Chromium writing into a deleted profile loses the user's session state.
  await deps.stop(name)
  deps.removeBrowser(name)
  res.statusCode = 204
  res.end()
}

async function launchSession(
  name: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  deps: BrowserRouteDeps,
): Promise<void> {
  const requested = typeof body.url === "string" && body.url ? body.url : null
  const url = requested ?? (await deps.readBrowser(name, deps.isRunning)).lastUrl ?? BLANK_URL
  if (url.startsWith("-")) {
    sendJson(res, 400, { error: `Browser url ${JSON.stringify(url)} must not start with "-"` })
    return
  }
  if (url.length > MAX_URL_LENGTH) {
    sendJson(res, 400, { error: `Browser url must be at most ${MAX_URL_LENGTH} characters` })
    return
  }
  // The daemon rejects the scheme too; checking here is what tells a bad request
  // (400) apart from a browser that would not start (502).
  try {
    resolveNavigationUrl(url)
  } catch (error) {
    sendJson(res, 400, { error: messageOf(error) })
    return
  }
  try {
    await deps.launch(name, url)
  } catch (error) {
    sendJson(res, 502, { error: messageOf(error) })
    return
  }
  sendJson(res, 200, { ok: true })
}

async function stopSession(name: string, res: ServerResponse, deps: BrowserRouteDeps): Promise<void> {
  await deps.stop(name)
  sendJson(res, 200, { ok: true })
}

function installBrowserSkill(
  body: Record<string, unknown>,
  res: ServerResponse,
  deps: BrowserRouteDeps,
): void {
  const { target } = body
  if (typeof target !== "string" || !(SKILL_TARGETS as readonly string[]).includes(target)) {
    sendJson(res, 400, { error: `target must be one of: ${SKILL_TARGETS.join(", ")}` })
    return
  }
  sendJson(res, 200, { path: deps.installSkill(target as AgentKind) })
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
  deps: BrowserRouteDeps,
): Promise<void> {
  const method = req.method ?? "GET"
  const path = subPath(req.url ?? "/")

  if (path === "/") {
    if (method !== "GET") return next()
    return sendStatus(res, deps)
  }
  if (path === "/sessions") {
    if (method !== "POST") return next()
    return createSession(await readBody(req), res, deps)
  }
  if (path === "/skill/install") {
    if (method !== "POST") return next()
    return installBrowserSkill(await readBody(req), res, deps)
  }

  const [collection, segment, action, ...rest] = path.split("/").slice(1)
  if (collection !== "sessions" || segment === undefined || rest.length > 0) return next()
  const name = browserName(segment)

  if (action === undefined) {
    if (method === "PATCH") return patchSession(name, await readBody(req), res, deps)
    if (method === "DELETE") return deleteSession(name, res, deps)
    return next()
  }
  if (method !== "POST") return next()
  if (action === "launch") return launchSession(name, await readBody(req), res, deps)
  if (action === "stop") return stopSession(name, res, deps)
  return next()
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof BrowserNameError) return sendJson(res, 400, { error: error.message })
  if (error instanceof BrowserNotFoundError) return sendJson(res, 404, { error: error.message })
  if (error instanceof BrowserExistsError) return sendJson(res, 409, { error: error.message })
  if (error instanceof HttpBodyError) return sendJson(res, error.statusCode, { error: error.message })
  throw error
}

export function registerBrowserRoutes(
  use: UseFn,
  deps: BrowserRouteDeps = defaultBrowserRouteDeps,
): void {
  use("/api/browser", async (req, res, next) => {
    try {
      await dispatch(req, res, next, deps)
    } catch (error) {
      sendError(res, error)
    }
  })
}
