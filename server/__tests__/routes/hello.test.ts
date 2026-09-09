// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../config", () => ({
  getConfig: vi.fn(),
}))

vi.mock("../../team/users", () => ({
  isUsersStoreInitialized: vi.fn(() => false),
  userCount: vi.fn(() => 0),
}))

import { getConfig } from "../../config"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerHelloRoutes, getInstanceId } from "../../routes/hello"
import { initEdition, __resetEditionForTest } from "../../team/edition"
import { isUsersStoreInitialized, userCount } from "../../team/users"

const mockedGetConfig = vi.mocked(getConfig)
const mockedIsUsersStoreInitialized = vi.mocked(isUsersStoreInitialized)
const mockedUserCount = vi.mocked(userCount)

function register(mode: "electron" | "standalone" | "dev" = "electron") {
  return getRouteHandler(collectRoutes((use) => registerHelloRoutes(use, { mode })), "/api/hello")
}

describe("GET /api/hello", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedIsUsersStoreInitialized.mockReturnValue(false)
    mockedUserCount.mockReturnValue(0)
    delete process.env.COGPIT_DEVICE_NAME
    delete process.env.COGPIT_EDITION
  })
  afterEach(() => {
    delete process.env.COGPIT_DEVICE_NAME
    delete process.env.COGPIT_EDITION
    __resetEditionForTest()
  })

  it("calls next for non-GET methods", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("POST")
    handler(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
  })

  it("returns the cogpit handshake payload", () => {
    const handler = register("standalone")
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    const body = JSON.parse(res._getData())
    expect(body.app).toBe("cogpit")
    expect(body.hubApi).toBe(1)
    expect(body.mode).toBe("standalone")
    expect(typeof body.version).toBe("string")
    expect(body.version.length).toBeGreaterThan(0)
    expect(body.instanceId).toMatch(/^[0-9a-f]{16}$/)
    expect(res._getHeaders()["Content-Type"]).toBe("application/json")
  })

  it("reports the personal edition before any initEdition runs", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).edition).toBe("personal")
  })

  it("reports the team edition once resolved for the standalone shell", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    const handler = register("standalone")
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).edition).toBe("team")
  })

  it("advertises the open first-admin bootstrap for a team server with no users", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    mockedIsUsersStoreInitialized.mockReturnValue(true)
    mockedUserCount.mockReturnValue(0)
    const handler = register("standalone")
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).needsBootstrap).toBe(true)
  })

  it("closes the bootstrap signal once a user exists", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    mockedIsUsersStoreInitialized.mockReturnValue(true)
    mockedUserCount.mockReturnValue(1)
    const handler = register("standalone")
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).needsBootstrap).toBe(false)
  })

  it("keeps the bootstrap signal closed before the users store initializes", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    mockedIsUsersStoreInitialized.mockReturnValue(false)
    mockedUserCount.mockReturnValue(0)
    const handler = register("standalone")
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).needsBootstrap).toBe(false)
  })

  it("never advertises a bootstrap in personal edition", () => {
    mockedIsUsersStoreInitialized.mockReturnValue(true)
    mockedUserCount.mockReturnValue(0)
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    const body = JSON.parse(res._getData())
    expect(body.edition).toBe("personal")
    expect(body.needsBootstrap).toBe(false)
  })

  it("reports networkAccess:false and configured:false when unconfigured", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    const body = JSON.parse(res._getData())
    expect(body.networkAccess).toBe(false)
    expect(body.configured).toBe(false)
  })

  it("reflects network access and configured state from config", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce({
      claudeDir: "/x", networkAccess: true, networkPassword: "hashed",
    })

    handler(req, res, next)

    const body = JSON.parse(res._getData())
    expect(body.networkAccess).toBe(true)
    expect(body.configured).toBe(true)
  })

  it("never leaks the network password", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce({
      claudeDir: "/x", networkAccess: true, networkPassword: "super-secret",
    })

    handler(req, res, next)

    expect(res._getData()).not.toContain("super-secret")
  })

  it("uses COGPIT_DEVICE_NAME when set", () => {
    process.env.COGPIT_DEVICE_NAME = "studio-mac"
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).name).toBe("studio-mac")
  })

  it("falls back to a non-empty hostname when no override is set", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(typeof JSON.parse(res._getData()).name).toBe("string")
    expect(JSON.parse(res._getData()).name.length).toBeGreaterThan(0)
  })
})

describe("getInstanceId", () => {
  it("is a stable 8-byte hex string for the process lifetime", () => {
    expect(getInstanceId()).toMatch(/^[0-9a-f]{16}$/)
    expect(getInstanceId()).toBe(getInstanceId())
  })
})
