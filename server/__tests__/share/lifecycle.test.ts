// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join as joinPath } from "node:path"

// Every route under test reads the same `../../helpers` barrel, so one factory
// has to cover the union of what claude-manage, config and the branch route
// import from it.
vi.mock("../../helpers", () => ({
  activeProcesses: new Map(),
  persistentSessions: new Map(),
  dirs: { PROJECTS_DIR: "/tmp/lifecycle-projects" },
  CODEX_SESSIONS_DIR: "/tmp/lifecycle-codex",
  isCodexDirName: vi.fn(() => false),
  isWithinDir: vi.fn(() => true),
  resolveSessionFilePath: vi.fn(
    (dirName: string, fileName: string) => `/tmp/lifecycle-projects/${dirName}/${fileName}`,
  ),
  unlink: vi.fn().mockResolvedValue(undefined),
  spawn: vi.fn(),
  dirname: (path: string) => path.split("/").slice(0, -1).join("/"),
  join: (...parts: string[]) => parts.join("/"),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  formatCodexRolloutFileName: vi.fn((id: string) => `rollout-${id}.jsonl`),
  randomUUID: vi.fn(() => "branched-session"),
  refreshDirs: vi.fn(),
  isTrustedDirectLocalRequest: vi.fn(() => false),
  hasTrustedMutationSource: vi.fn(() => true),
  canIssueBrowserSession: vi.fn(() => true),
  isRateLimited: vi.fn(() => false),
  createSessionToken: vi.fn(() => "device-token"),
  getRequestSessionToken: vi.fn(() => null),
  setBrowserSessionCookie: vi.fn(),
  clearBrowserSessionCookie: vi.fn(),
  revokeSessionToken: vi.fn(),
  needsPasswordRehash: vi.fn(() => false),
  hashPassword: vi.fn((password: string) => `hashed:${password}`),
  validatePasswordStrength: vi.fn(() => null),
  revokeAllSessions: vi.fn().mockResolvedValue(undefined),
  getConnectedDevices: vi.fn(() => []),
}))

vi.mock("../../config", () => ({
  getConfig: vi.fn(),
  getConfiguredEditionValue: vi.fn(() => "personal"),
  saveConfig: vi.fn().mockResolvedValue(undefined),
  validateClaudeDir: vi.fn().mockResolvedValue({ valid: true, resolved: "/home/user/.claude" }),
}))

vi.mock("../../sdk-session", () => ({
  stopSDKSession: vi.fn(() => false),
  cleanupAllSDKSessions: vi.fn(() => 0),
  interruptSDKTurn: vi.fn(),
  updateSDKSession: vi.fn(),
  rewindClaudeFiles: vi.fn(),
  stopSDKTask: vi.fn(),
  backgroundSDKTasks: vi.fn(),
}))

import type { Middleware, UseFn } from "../../helpers"
import { readFile } from "../../helpers"
import { getConfig, validateClaudeDir } from "../../config"
import {
  createShareToken,
  countShareGuests,
  validateShareToken,
  __resetShareTokensForTest,
} from "../../security"
import {
  createShare,
  getShareWithHash,
  initShareRegistry,
  listShares,
} from "../../share/registry"
import { registerClaudeManageRoutes } from "../../routes/claude-manage"
import { registerConfigRoutes } from "../../routes/config"
import { registerBranchSessionRoute } from "../../routes/claude-new/sessionBranching"

const mockedReadFile = vi.mocked(readFile)
const mockedGetConfig = vi.mocked(getConfig)
const mockedValidateClaudeDir = vi.mocked(validateClaudeDir)

function createMockReqRes(method: string, url = "/", body?: string) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []
  const req = {
    method,
    url,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    },
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }

  let endData = ""
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { endData = data || "" }),
    _getData: () => JSON.parse(endData || "{}"),
  }

  const next = vi.fn()
  const sendBody = () => {
    if (body) for (const handler of dataHandlers) handler(Buffer.from(body))
    for (const handler of endHandlers) handler()
  }

  return { req, res, next, sendBody }
}

async function callRoute(
  handler: Middleware,
  method: string,
  url: string,
  body?: string,
) {
  const { req, res, next, sendBody } = createMockReqRes(method, url, body)
  handler(req as never, res as never, next)
  sendBody()
  await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
  return res
}

describe("share lifecycle", () => {
  let registryDir: string
  let handlers: Map<string, Middleware>

  beforeEach(async () => {
    vi.clearAllMocks()
    __resetShareTokensForTest()
    registryDir = await mkdtemp(joinPath(tmpdir(), "share-lifecycle-"))
    await initShareRegistry(registryDir)

    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => { handlers.set(path, handler) }
    registerClaudeManageRoutes(use)
    registerConfigRoutes(use)
    registerBranchSessionRoute(use)
  })

  afterEach(async () => {
    __resetShareTokensForTest()
    await rm(registryDir, { recursive: true, force: true })
  })

  it("deletes the share when its session is deleted", async () => {
    await createShare({ sessionId: "doomed", dirName: "proj", fileName: "doomed.jsonl" })
    await createShare({ sessionId: "bystander", dirName: "proj", fileName: "bystander.jsonl" })
    createShareToken("doomed", "10.0.0.5", "guest-ua")
    createShareToken("bystander", "10.0.0.6", "guest-ua")

    const res = await callRoute(
      handlers.get("/api/delete-session")!,
      "POST",
      "/",
      JSON.stringify({ dirName: "proj", fileName: "doomed.jsonl" }),
    )

    expect(res._getData()).toEqual({ success: true })
    // A later session that reuses the id must not inherit this access.
    expect(getShareWithHash("doomed")).toBeUndefined()
    expect(countShareGuests("doomed")).toBe(0)
    expect(getShareWithHash("bystander")).toBeDefined()
    expect(countShareGuests("bystander")).toBe(1)
  })

  it("deletes the share of a Codex session, whose file name is not its session id", async () => {
    await createShare({
      sessionId: "codex-uuid",
      dirName: "codex-proj",
      fileName: "rollout-2026-03-18T10-00-00-codex-uuid.jsonl",
    })
    createShareToken("codex-uuid", "10.0.0.5", "guest-ua")

    await callRoute(
      handlers.get("/api/delete-session")!,
      "POST",
      "/",
      JSON.stringify({
        dirName: "codex-proj",
        fileName: "rollout-2026-03-18T10-00-00-codex-uuid.jsonl",
      }),
    )

    expect(getShareWithHash("codex-uuid")).toBeUndefined()
    expect(countShareGuests("codex-uuid")).toBe(0)
  })

  it("revokes live guest tokens but keeps the records when network access is disabled", async () => {
    await createShare({ sessionId: "shared-a", dirName: "proj", fileName: "shared-a.jsonl" })
    await createShare({ sessionId: "shared-b", dirName: "proj", fileName: "shared-b.jsonl" })
    createShareToken("shared-a", "10.0.0.5", "guest-ua")
    createShareToken("shared-b", "10.0.0.6", "guest-ua")

    mockedGetConfig.mockReturnValue({
      claudeDir: "/home/user/.claude",
      networkAccess: true,
      networkPassword: "hashed:old-password",
    } as never)

    const res = await callRoute(
      handlers.get("/api/config")!,
      "POST",
      "/",
      JSON.stringify({ claudeDir: "/home/user/.claude", networkAccess: false }),
    )

    expect(res._getData()).toMatchObject({ success: true })
    // Re-enabling network access must not silently re-admit an old guest.
    expect(countShareGuests("shared-a")).toBe(0)
    expect(countShareGuests("shared-b")).toBe(0)
    // The passphrases still work: the host never turned the shares off.
    expect(listShares().map((share) => share.sessionId)).toEqual(["shared-a", "shared-b"])
  })

  it("leaves shares and their live guests alone when the network password changes", async () => {
    await createShare({ sessionId: "shared-a", dirName: "proj", fileName: "shared-a.jsonl" })
    createShareToken("shared-a", "10.0.0.5", "guest-ua")

    mockedGetConfig.mockReturnValue({
      claudeDir: "/home/user/.claude",
      networkAccess: true,
      networkPassword: "hashed:old-password",
    } as never)

    const res = await callRoute(
      handlers.get("/api/config")!,
      "POST",
      "/",
      JSON.stringify({
        claudeDir: "/home/user/.claude",
        networkAccess: true,
        networkPassword: "a-brand-new-password",
      }),
    )

    expect(res._getData()).toMatchObject({ success: true })
    // The share passphrase is a deliberately separate credential from the
    // device password, so rotating one must not disturb the other.
    expect(countShareGuests("shared-a")).toBe(1)
    expect(getShareWithHash("shared-a")).toBeDefined()
  })

  it("clears every share when the projects root moves", async () => {
    await createShare({ sessionId: "shared-a", dirName: "proj", fileName: "shared-a.jsonl" })
    await createShare({ sessionId: "shared-b", dirName: "proj", fileName: "shared-b.jsonl" })
    const guestToken = createShareToken("shared-a", "10.0.0.5", "guest-ua")
    createShareToken("shared-b", "10.0.0.6", "guest-ua")

    mockedGetConfig.mockReturnValue({
      claudeDir: "/home/user/.claude",
      networkAccess: true,
      networkPassword: "hashed:old-password",
    } as never)
    mockedValidateClaudeDir.mockResolvedValue({ valid: true, resolved: "/home/user/other-claude" })

    const res = await callRoute(
      handlers.get("/api/config")!,
      "POST",
      "/",
      JSON.stringify({ claudeDir: "/home/user/other-claude", networkAccess: true }),
    )

    expect(res._getData()).toMatchObject({ success: true })
    // A record addresses a dirName/fileName inside one projects root. Under a
    // new root the same pair is a different session, or none.
    expect(listShares()).toEqual([])
    expect(validateShareToken(guestToken, "guest-ua")).toBeNull()
    expect(countShareGuests("shared-b")).toBe(0)
  })

  it("does not copy the share onto a branched session", async () => {
    await createShare({ sessionId: "source", dirName: "proj", fileName: "source.jsonl" })
    mockedReadFile.mockResolvedValue(
      [
        JSON.stringify({ sessionId: "source", type: "user" }),
        JSON.stringify({ type: "assistant" }),
      ].join("\n"),
    )

    const res = await callRoute(
      handlers.get("/api/branch-session")!,
      "POST",
      "/",
      JSON.stringify({ dirName: "proj", fileName: "source.jsonl" }),
    )

    expect(res._getData()).toMatchObject({ sessionId: "branched-session", branchedFrom: "source" })
    expect(getShareWithHash("branched-session")).toBeUndefined()
    expect(listShares().map((share) => share.sessionId)).toEqual(["source"])
  })
})
