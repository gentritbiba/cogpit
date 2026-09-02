// @vitest-environment node
/**
 * Host share API — POST/GET/DELETE /api/shares and the regenerate sub-route.
 *
 * The registry, the token store and scrypt are all real here. The point of
 * these tests is that a passphrase handed to the host actually unlocks the
 * record that was stored, and that turning a share off actually strands the
 * guests holding tokens for it — neither of which a mocked registry could say.
 */

import { Readable } from "node:stream"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const mockGetConfig = vi.hoisted(() => vi.fn())
const mockFindJsonlPath = vi.hoisted(() => vi.fn())
const mockResolveSessionFilePath = vi.hoisted(() => vi.fn())
const mockGetSessionMeta = vi.hoisted(() => vi.fn())

vi.mock("../../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config")>()),
  getConfig: mockGetConfig,
}))

vi.mock("../../helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../helpers")>()),
  getSessionMeta: mockGetSessionMeta,
}))

vi.mock("../../sessionPaths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessionPaths")>()),
  findJsonlPath: mockFindJsonlPath,
  resolveSessionFilePath: mockResolveSessionFilePath,
}))

import type { Middleware, UseFn } from "../../helpers"
import { storeFor } from "../../agents"

const CODEX_SESSIONS_DIR = storeFor("codex").sessionsRoot() as string
const COPILOT_SESSIONS_DIR = storeFor("copilot").sessionsRoot() as string
import { verifyPassword } from "../../password-utils"
import { registerShareRoutes } from "../../routes/shares"
import {
  createShareToken,
  validateShareToken,
  __resetShareTokensForTest,
} from "../../security"
import {
  initShareRegistry,
  getShareWithHash,
  listShares,
} from "../../share/registry"

const SESSION_ID = "sess-1"
const DIR_NAME = "-Users-me-proj"
const FILE_NAME = "sess-1.jsonl"
const FILE_PATH = `/Users/me/.claude/projects/${DIR_NAME}/${FILE_NAME}`

let registryRoot: string

function handlers(): Map<string, Middleware> {
  const collected = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => {
    collected.set(path, handler)
  }
  registerShareRoutes(use)
  return collected
}

interface CallOptions {
  method: string
  /** Already stripped of the mount prefix, exactly as the router hands it over. */
  url?: string
  body?: unknown
  headers?: Record<string, string>
}

async function call(mount: string, options: CallOptions) {
  const handler = handlers().get(mount)
  if (!handler) throw new Error(`Route was not registered: ${mount}`)

  const headers: Record<string, string> = {
    host: "cogpit.example",
    "user-agent": "Host/1",
    ...options.headers,
  }
  const payload = options.body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(options.body))
  const req = Object.assign(Readable.from([payload]), {
    method: options.method,
    url: options.url ?? "/",
    headers,
    socket: { remoteAddress: "203.0.113.9" },
  }) as never

  let raw = ""
  const responseHeaders = new Map<string, string>()
  let settle: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    settle = resolve
  })
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: (name: string, value: string) => {
      responseHeaders.set(name.toLowerCase(), value)
    },
    end: (data?: string) => {
      res.headersSent = true
      raw = data ?? ""
      settle()
    },
  }
  const next = vi.fn(() => settle())

  await handler(req, res as never, next)
  await finished

  return {
    res,
    next,
    responseHeaders,
    raw: () => raw,
    json: () => JSON.parse(raw) as Record<string, unknown>,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  registryRoot = await mkdtemp(join(tmpdir(), "cogpit-shares-route-"))
  await initShareRegistry(registryRoot)
  __resetShareTokensForTest()
  mockGetConfig.mockReturnValue({ networkAccess: true, networkPassword: "hashed" })
  mockFindJsonlPath.mockResolvedValue(FILE_PATH)
  mockResolveSessionFilePath.mockResolvedValue(FILE_PATH)
  mockGetSessionMeta.mockResolvedValue({ aiTitle: "Fixing the parser", cwd: "/Users/me/proj" })
})

afterEach(async () => {
  await rm(registryRoot, { recursive: true, force: true })
})

describe("POST /api/shares", () => {
  it("refuses a Codex session outright, and stores nothing", async () => {
    // A Codex rollout is addressed by a nested path
    // (2026/08/25/rollout-<ts>-<uuid>.jsonl). The share allowlist compares
    // identity segment by segment and requires exactly two, so a Codex record
    // would mint a passphrase for a share that 403s on every read. The
    // allowlist is not widened to fit: this function already shipped a
    // traversal bug once, and a looser segment rule reopens that surface.
    mockFindJsonlPath.mockResolvedValue(
      `${CODEX_SESSIONS_DIR}/2026/08/25/rollout-2026-08-25T10-00-00-codex-uuid.jsonl`,
    )

    const result = await call("/api/shares", {
      method: "POST",
      body: { sessionId: "codex-uuid" },
    })

    expect(result.res.statusCode).toBe(400)
    expect(result.json().error).toBe("Sharing Codex sessions isn't supported yet")
    expect(listShares()).toEqual([])
    expect(getShareWithHash("codex-uuid")).toBeUndefined()
  })

  it("refuses a Copilot session explicitly, and stores nothing", async () => {
    mockFindJsonlPath.mockResolvedValue(
      `${COPILOT_SESSIONS_DIR}/123e4567-e89b-42d3-a456-426614174000/events.jsonl`,
    )

    const result = await call("/api/shares", {
      method: "POST",
      body: { sessionId: "123e4567-e89b-42d3-a456-426614174000" },
    })

    expect(result.res.statusCode).toBe(400)
    expect(result.json().error).toBe("Sharing Copilot sessions isn't supported yet")
    expect(listShares()).toEqual([])
  })

  it("404s on a session with no transcript, and stores nothing", async () => {
    mockFindJsonlPath.mockResolvedValue(null)

    const { res, json } = await call("/api/shares", {
      method: "POST",
      body: { sessionId: "ghost" },
    })

    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: "Session not found" })
    expect(listShares()).toEqual([])
  })

  it("400s without a sessionId", async () => {
    const { res } = await call("/api/shares", { method: "POST", body: {} })
    expect(res.statusCode).toBe(400)
    expect(listShares()).toEqual([])
  })

  it("returns a passphrase that verifies against the stored hash", async () => {
    const { res, json } = await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })

    expect(res.statusCode).toBe(200)
    const passphrase = json().passphrase as string
    expect(typeof passphrase).toBe("string")
    const stored = getShareWithHash(SESSION_ID)
    expect(stored).toBeDefined()
    expect(verifyPassword(passphrase, stored!.passwordHash)).toBe(true)
  })

  it("resolves dirName and fileName server-side, ignoring anything the body names", async () => {
    const { json } = await call("/api/shares", {
      method: "POST",
      body: {
        sessionId: SESSION_ID,
        dirName: "-Users-me-secrets",
        fileName: "../../../../etc/passwd",
      },
    })

    expect(json().share).toMatchObject({ dirName: DIR_NAME, fileName: FILE_NAME })
    expect(getShareWithHash(SESSION_ID)).toMatchObject({
      dirName: DIR_NAME,
      fileName: FILE_NAME,
    })
  })

  it("refuses to share a file the session routes cannot address", async () => {
    // findJsonlPath found it, but dirName/fileName do not round-trip to the
    // same file, so a guest could never read it — do not mint a dead share.
    mockResolveSessionFilePath.mockResolvedValue("/somewhere/else.jsonl")

    const { res } = await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })

    expect(res.statusCode).toBe(404)
    expect(listShares()).toEqual([])
  })

  it("keeps one record when a session is shared twice, and the second passphrase wins", async () => {
    const first = (await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })).json().passphrase as string
    const second = (await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })).json().passphrase as string

    expect(listShares()).toHaveLength(1)
    const stored = getShareWithHash(SESSION_ID)!
    expect(verifyPassword(second, stored.passwordHash)).toBe(true)
    expect(verifyPassword(first, stored.passwordHash)).toBe(false)
  })

  it("strands guests holding a token from the previous passphrase", async () => {
    await call("/api/shares", { method: "POST", body: { sessionId: SESSION_ID } })
    const guest = createShareToken(SESSION_ID, "203.0.113.5", "Guest/1")

    await call("/api/shares", { method: "POST", body: { sessionId: SESSION_ID } })

    expect(validateShareToken(guest, "Guest/1")).toBeNull()
  })

  it("refuses to create a share while network access is off", async () => {
    mockGetConfig.mockReturnValue({ networkAccess: false, networkPassword: "hashed" })

    const { res, json } = await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })

    expect(res.statusCode).toBe(409)
    expect(String(json().error)).toMatch(/network access/i)
    expect(listShares()).toEqual([])
  })

  it("never returns the stored hash", async () => {
    const { raw, json } = await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })

    expect(raw()).not.toContain("$scrypt$")
    expect(json().share).not.toHaveProperty("passwordHash")
  })

  it("returns a link the guest can open", async () => {
    const { json } = await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })

    expect(json().url).toBe(`/shared/${SESSION_ID}`)
  })
})

describe("GET /api/shares", () => {
  it("lists shares without a hash or a passphrase", async () => {
    const created = await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })
    const passphrase = created.json().passphrase as string

    const { res, raw } = await call("/api/shares", { method: "GET", url: "/" })

    expect(res.statusCode).toBe(200)
    const listed = JSON.parse(raw()) as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)
    expect(listed[0]).not.toHaveProperty("passwordHash")
    expect(raw()).not.toContain(passphrase)
    expect(raw()).not.toContain("$scrypt$")
  })

  it("reports the session title and a live guest count", async () => {
    await call("/api/shares", { method: "POST", body: { sessionId: SESSION_ID } })
    createShareToken(SESSION_ID, "203.0.113.5", "Guest/1")
    createShareToken(SESSION_ID, "203.0.113.6", "Guest/2")
    createShareToken("other-session", "203.0.113.7", "Guest/3")

    const { raw } = await call("/api/shares", { method: "GET", url: "" })

    const listed = JSON.parse(raw()) as Array<Record<string, unknown>>
    expect(listed[0]).toMatchObject({
      sessionId: SESSION_ID,
      dirName: DIR_NAME,
      fileName: FILE_NAME,
      title: "Fixing the parser",
      guests: 2,
    })
  })

  it("still lists a share whose transcript can no longer be read", async () => {
    await call("/api/shares", { method: "POST", body: { sessionId: SESSION_ID } })
    mockGetSessionMeta.mockRejectedValue(new Error("gone"))

    const { res, raw } = await call("/api/shares", { method: "GET", url: "/" })

    expect(res.statusCode).toBe(200)
    expect((JSON.parse(raw()) as Array<Record<string, unknown>>)[0]).toMatchObject({
      sessionId: SESSION_ID,
      title: "",
    })
  })
})

describe("DELETE /api/shares/:sessionId", () => {
  it("removes the record and strands its guests", async () => {
    await call("/api/shares", { method: "POST", body: { sessionId: SESSION_ID } })
    const guest = createShareToken(SESSION_ID, "203.0.113.5", "Guest/1")

    const { res, json } = await call("/api/shares", {
      method: "DELETE",
      url: `/${SESSION_ID}`,
    })

    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(listShares()).toEqual([])
    expect(validateShareToken(guest, "Guest/1")).toBeNull()
  })

  it("404s on a session that is not shared", async () => {
    const { res } = await call("/api/shares", { method: "DELETE", url: "/never-shared" })
    expect(res.statusCode).toBe(404)
  })
})

describe("POST /api/shares/:sessionId/regenerate", () => {
  it("changes the hash and strands existing guests", async () => {
    const first = (await call("/api/shares", {
      method: "POST",
      body: { sessionId: SESSION_ID },
    })).json().passphrase as string
    const guest = createShareToken(SESSION_ID, "203.0.113.5", "Guest/1")
    const before = getShareWithHash(SESSION_ID)!.passwordHash

    const { res, json } = await call("/api/shares", {
      method: "POST",
      url: `/${SESSION_ID}/regenerate`,
    })

    expect(res.statusCode).toBe(200)
    const passphrase = json().passphrase as string
    const after = getShareWithHash(SESSION_ID)!
    expect(after.passwordHash).not.toBe(before)
    expect(verifyPassword(passphrase, after.passwordHash)).toBe(true)
    expect(verifyPassword(first, after.passwordHash)).toBe(false)
    expect(validateShareToken(guest, "Guest/1")).toBeNull()
  })

  it("404s on a session that is not shared", async () => {
    const { res } = await call("/api/shares", {
      method: "POST",
      url: "/never-shared/regenerate",
    })
    expect(res.statusCode).toBe(404)
  })
})

describe("/api/shares routing", () => {
  it("hands unknown methods and shapes back to the router", async () => {
    const put = await call("/api/shares", { method: "PUT", url: "/", body: {} })
    expect(put.next).toHaveBeenCalledOnce()

    const nested = await call("/api/shares", {
      method: "DELETE",
      url: `/${SESSION_ID}/extra/segments`,
    })
    expect(nested.next).toHaveBeenCalledOnce()
  })
})
