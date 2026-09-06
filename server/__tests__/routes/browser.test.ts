// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserSessionInfo } from "../../../shared/browser/types"
import { AGENT_KINDS, descriptorFor } from "../../../shared/session/agent-descriptors"
import { BrowserNameError, DEFAULT_BROWSER } from "../../browser/paths"
import { BrowserExistsError, BrowserNotFoundError, type BrowserPatch } from "../../browser/registry"
import type { Middleware, UseFn } from "../../http"
import { registerBrowserRoutes, type BrowserRouteDeps } from "../../routes/browser"

const BINARY = "/opt/homebrew/bin/agent-browser"
/** Derived, not spelled: the route offers whichever CLIs the descriptor table gives a skills dir. */
const SUPPORTED_TARGET = AGENT_KINDS.filter((kind) => descriptorFor(kind).config.skillsDir !== null)[0]

function info(name: string, overrides: Partial<BrowserSessionInfo> = {}): BrowserSessionInfo {
  return {
    name,
    isDefault: name === DEFAULT_BROWSER,
    running: false,
    note: null,
    createdAt: "2026-09-06T09:00:00.000Z",
    lastUsedAt: null,
    lastUrl: null,
    driverSessionId: null,
    ...overrides,
  }
}

function createDeps() {
  return {
    binaryPath: vi.fn((): string | null => BINARY),
    listBrowsers: vi.fn(async () => [info(DEFAULT_BROWSER)]),
    readBrowser: vi.fn(async (name: string) => info(name)),
    createBrowser: vi.fn((name: string, note?: string) => info(name, { note: note ?? null })),
    updateBrowser: vi.fn((_name: string, _patch: BrowserPatch) => undefined),
    removeBrowser: vi.fn((_name: string) => undefined),
    isRunning: vi.fn(async () => false),
    launch: vi.fn(async (_name: string, _url: string) => undefined),
    stop: vi.fn(async (_name: string) => undefined),
    installSkill: vi.fn((target: string) => `/tmp/home/.${target}/skills/cogpit-browser`),
  } satisfies BrowserRouteDeps
}

type Deps = ReturnType<typeof createDeps>

let deps: Deps

function handler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, middleware) => {
    handlers.set(path, middleware)
  }
  registerBrowserRoutes(use, deps)
  return handlers.get("/api/browser")!
}

/**
 * Drives one request. `done` settles on the first of res.end() or next(), so a
 * fall-through is awaited exactly like an answered request.
 */
async function drive(method: string, url: string, body?: unknown) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []
  let statusCode = 200
  let payload = ""
  let settle!: () => void
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const req = {
    method,
    url,
    headers: {},
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(listener as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(listener as () => void)
      return req
    },
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => {
      payload = data ?? ""
      settle()
    }),
  }
  const next = vi.fn(() => settle())

  handler()(req as never, res as never, next)
  if (body !== undefined) {
    const raw = typeof body === "string" ? body : JSON.stringify(body)
    for (const listener of dataHandlers) listener(Buffer.from(raw))
  }
  for (const listener of endHandlers) listener()
  await done

  return {
    next,
    status: () => statusCode,
    body: () => (payload ? (JSON.parse(payload) as Record<string, unknown>) : null),
    raw: () => payload,
  }
}

beforeEach(() => {
  deps = createDeps()
})

// ── GET /api/browser ────────────────────────────────────────────────────────

describe("GET /api/browser", () => {
  it("reports the binary, the installed flag and the sessions", async () => {
    const sessions = [info(DEFAULT_BROWSER), info("github", { running: true })]
    deps.listBrowsers.mockResolvedValue(sessions)

    const call = await drive("GET", "/")

    expect(call.status()).toBe(200)
    expect(call.body()).toEqual({ installed: true, binaryPath: BINARY, sessions })
    expect(deps.listBrowsers).toHaveBeenCalledWith(deps.isRunning)
  })

  it("reports not installed when no real binary is on PATH", async () => {
    deps.binaryPath.mockReturnValue(null)

    const call = await drive("GET", "/")

    expect(call.body()).toMatchObject({ installed: false, binaryPath: null })
  })

  it("falls through for a non-GET method", async () => {
    const call = await drive("POST", "/", {})
    expect(call.next).toHaveBeenCalled()
  })
})

// ── POST /api/browser/sessions ──────────────────────────────────────────────

describe("POST /api/browser/sessions", () => {
  it("creates the browser and answers 201 with its info", async () => {
    const call = await drive("POST", "/sessions", { name: "github", note: "release bot" })

    expect(call.status()).toBe(201)
    expect(call.body()).toMatchObject({ name: "github", note: "release bot" })
    expect(deps.createBrowser).toHaveBeenCalledWith("github", "release bot")
  })

  it("omits a non-string note", async () => {
    await drive("POST", "/sessions", { name: "github", note: 7 })
    expect(deps.createBrowser).toHaveBeenCalledWith("github", undefined)
  })

  it("rejects a missing name without touching the registry", async () => {
    const call = await drive("POST", "/sessions", {})

    expect(call.status()).toBe(400)
    expect(deps.createBrowser).not.toHaveBeenCalled()
  })

  it("maps BrowserNameError to 400", async () => {
    deps.createBrowser.mockImplementation(() => {
      throw new BrowserNameError("bad name")
    })

    const call = await drive("POST", "/sessions", { name: "tmp-1" })

    expect(call.status()).toBe(400)
    expect(call.body()).toEqual({ error: "bad name" })
  })

  it("maps BrowserExistsError to 409", async () => {
    deps.createBrowser.mockImplementation((name) => {
      throw new BrowserExistsError(name)
    })

    const call = await drive("POST", "/sessions", { name: "github" })

    expect(call.status()).toBe(409)
  })

  it("rejects an unparseable body", async () => {
    const call = await drive("POST", "/sessions", "{oops")

    expect(call.status()).toBe(400)
    expect(deps.createBrowser).not.toHaveBeenCalled()
  })

  it("falls through for a non-POST method", async () => {
    const call = await drive("GET", "/sessions")
    expect(call.next).toHaveBeenCalled()
  })
})

// ── PATCH /api/browser/sessions/:name ───────────────────────────────────────

describe("PATCH /api/browser/sessions/:name", () => {
  it("stores the note and answers with the refreshed info", async () => {
    deps.readBrowser.mockResolvedValue(info("github", { note: "release bot" }))

    const call = await drive("PATCH", "/sessions/github", { note: "release bot" })

    expect(call.status()).toBe(200)
    expect(call.body()).toMatchObject({ name: "github", note: "release bot" })
    expect(deps.updateBrowser).toHaveBeenCalledWith("github", { note: "release bot" })
    expect(deps.readBrowser).toHaveBeenCalledWith("github", deps.isRunning)
  })

  it("clears the note with an explicit null", async () => {
    await drive("PATCH", "/sessions/github", { note: null })
    expect(deps.updateBrowser).toHaveBeenCalledWith("github", { note: null })
  })

  it("ignores fields other than note", async () => {
    await drive("PATCH", "/sessions/github", { lastUrl: "https://example.com" })
    expect(deps.updateBrowser).toHaveBeenCalledWith("github", {})
  })

  it("maps BrowserNotFoundError to 404", async () => {
    deps.updateBrowser.mockImplementation((name) => {
      throw new BrowserNotFoundError(name)
    })

    const call = await drive("PATCH", "/sessions/github", { note: "x" })

    expect(call.status()).toBe(404)
  })

  it("rejects an invalid name before the registry sees it", async () => {
    const call = await drive("PATCH", "/sessions/Github", { note: "x" })

    expect(call.status()).toBe(400)
    expect(deps.updateBrowser).not.toHaveBeenCalled()
  })

  it("rejects a throwaway name", async () => {
    const call = await drive("PATCH", "/sessions/tmp-a3f9", { note: "x" })

    expect(call.status()).toBe(400)
    expect(deps.updateBrowser).not.toHaveBeenCalled()
  })
})

// ── DELETE /api/browser/sessions/:name ──────────────────────────────────────

describe("DELETE /api/browser/sessions/:name", () => {
  it("stops the daemon before removing the profile", async () => {
    const order: string[] = []
    deps.stop.mockImplementation(async () => {
      await Promise.resolve()
      order.push("stop")
    })
    deps.removeBrowser.mockImplementation(() => {
      order.push("remove")
    })

    const call = await drive("DELETE", "/sessions/github")

    expect(call.status()).toBe(204)
    expect(call.raw()).toBe("")
    expect(order).toEqual(["stop", "remove"])
    expect(deps.stop).toHaveBeenCalledWith("github")
    expect(deps.removeBrowser).toHaveBeenCalledWith("github")
  })

  it("refuses to remove the default browser without stopping it", async () => {
    const call = await drive("DELETE", `/sessions/${DEFAULT_BROWSER}`)

    expect(call.status()).toBe(400)
    expect(deps.stop).not.toHaveBeenCalled()
    expect(deps.removeBrowser).not.toHaveBeenCalled()
  })

  it("rejects a percent-encoded traversal without stopping anything", async () => {
    const call = await drive("DELETE", "/sessions/%2e%2e%2fetc")

    expect(call.status()).toBe(400)
    expect(deps.stop).not.toHaveBeenCalled()
    expect(deps.removeBrowser).not.toHaveBeenCalled()
  })

  it("rejects a percent-encoded slash in the name", async () => {
    const call = await drive("DELETE", "/sessions/github%2fmain")

    expect(call.status()).toBe(400)
    expect(deps.removeBrowser).not.toHaveBeenCalled()
  })

  it("rejects malformed percent-encoding", async () => {
    const call = await drive("DELETE", "/sessions/%zz")

    expect(call.status()).toBe(400)
    expect(deps.removeBrowser).not.toHaveBeenCalled()
  })

  it("falls through for an unsupported method on the item", async () => {
    const call = await drive("PUT", "/sessions/github", {})
    expect(call.next).toHaveBeenCalled()
  })
})

// ── POST /api/browser/sessions/:name/launch ─────────────────────────────────

describe("POST /api/browser/sessions/:name/launch", () => {
  it("launches the url from the body", async () => {
    const call = await drive("POST", "/sessions/github/launch", { url: "https://example.com" })

    expect(call.status()).toBe(200)
    expect(call.body()).toEqual({ ok: true })
    expect(deps.launch).toHaveBeenCalledWith("github", "https://example.com")
  })

  it("falls back to the recorded lastUrl when the body omits one", async () => {
    deps.readBrowser.mockResolvedValue(info("github", { lastUrl: "https://example.com/inbox" }))

    await drive("POST", "/sessions/github/launch", {})

    expect(deps.launch).toHaveBeenCalledWith("github", "https://example.com/inbox")
  })

  it("prefers the body url over the recorded lastUrl", async () => {
    deps.readBrowser.mockResolvedValue(info("github", { lastUrl: "https://example.com/inbox" }))

    await drive("POST", "/sessions/github/launch", { url: "https://example.com/new" })

    expect(deps.launch).toHaveBeenCalledWith("github", "https://example.com/new")
    expect(deps.readBrowser).not.toHaveBeenCalled()
  })

  it("falls back to about:blank when nothing is known", async () => {
    await drive("POST", "/sessions/github/launch", {})
    expect(deps.launch).toHaveBeenCalledWith("github", "about:blank")
  })

  it("accepts an empty body", async () => {
    const call = await drive("POST", "/sessions/github/launch")

    expect(call.status()).toBe(200)
    expect(deps.launch).toHaveBeenCalledWith("github", "about:blank")
  })

  it("rejects a url that would read as a flag", async () => {
    const call = await drive("POST", "/sessions/github/launch", { url: "--headed" })

    expect(call.status()).toBe(400)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it.each(["file:///Users/x/.ssh/id_rsa", "javascript:alert(1)", "data:text/html,hi", "chrome://settings"])(
    "rejects %s with 400",
    async (url) => {
      const call = await drive("POST", "/sessions/github/launch", { url })

      expect(call.status()).toBe(400)
      expect(deps.launch).not.toHaveBeenCalled()
    },
  )

  it("rejects an oversized url", async () => {
    const call = await drive("POST", "/sessions/github/launch", {
      url: `https://example.com/${"a".repeat(2048)}`,
    })

    expect(call.status()).toBe(400)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it("answers 502 with the failure when the browser will not start", async () => {
    deps.launch.mockRejectedValue(new Error("agent-browser failed (1): no display"))

    const call = await drive("POST", "/sessions/github/launch", {})

    expect(call.status()).toBe(502)
    expect(call.body()).toEqual({ error: "agent-browser failed (1): no display" })
  })

  it("falls through for a non-POST method", async () => {
    const call = await drive("GET", "/sessions/github/launch")
    expect(call.next).toHaveBeenCalled()
  })
})

// ── POST /api/browser/sessions/:name/stop ───────────────────────────────────

describe("POST /api/browser/sessions/:name/stop", () => {
  it("stops the browser", async () => {
    const call = await drive("POST", "/sessions/github/stop")

    expect(call.status()).toBe(200)
    expect(call.body()).toEqual({ ok: true })
    expect(deps.stop).toHaveBeenCalledWith("github")
  })

  it("rejects an invalid name", async () => {
    const call = await drive("POST", "/sessions/Github/stop")

    expect(call.status()).toBe(400)
    expect(deps.stop).not.toHaveBeenCalled()
  })

  it("falls through for a non-POST method", async () => {
    const call = await drive("DELETE", "/sessions/github/stop")
    expect(call.next).toHaveBeenCalled()
  })
})

// ── POST /api/browser/skill/install ─────────────────────────────────────────

describe("POST /api/browser/skill/install", () => {
  it("installs the skill for a supported target", async () => {
    const call = await drive("POST", "/skill/install", { target: SUPPORTED_TARGET })

    expect(call.status()).toBe(200)
    expect(call.body()).toEqual({ path: `/tmp/home/.${SUPPORTED_TARGET}/skills/cogpit-browser` })
    expect(deps.installSkill).toHaveBeenCalledWith(SUPPORTED_TARGET)
  })

  it("rejects an unknown target", async () => {
    const call = await drive("POST", "/skill/install", { target: "notepad" })

    expect(call.status()).toBe(400)
    expect(deps.installSkill).not.toHaveBeenCalled()
  })

  it("rejects a missing target", async () => {
    const call = await drive("POST", "/skill/install", {})

    expect(call.status()).toBe(400)
    expect(deps.installSkill).not.toHaveBeenCalled()
  })

  it("falls through for a non-POST method", async () => {
    const call = await drive("GET", "/skill/install")
    expect(call.next).toHaveBeenCalled()
  })
})

// ── Unknown paths ───────────────────────────────────────────────────────────

describe("unknown sub-paths", () => {
  it.each([
    ["/nope"],
    ["/sessions/github/launch/extra"],
    ["/skill"],
    ["/skill/uninstall"],
  ])("falls through for %s", async (path) => {
    const call = await drive("POST", path, {})
    expect(call.next).toHaveBeenCalled()
  })
})
