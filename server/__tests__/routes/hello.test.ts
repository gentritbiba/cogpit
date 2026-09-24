// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("../../config", () => ({
  getConfig: vi.fn(),
}))

import { getConfig } from "../../config"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerHelloRoutes, getInstanceId } from "../../routes/hello"
import { __resetEditionForTest } from "../../edition"
import { fakeEditionAuth } from "../edition/fakeAuth"
import { installFakeEdition } from "../edition/fakeEdition"

const mockedGetConfig = vi.mocked(getConfig)

function register(mode: "electron" | "standalone" | "dev" = "electron") {
  return getRouteHandler(collectRoutes((use) => registerHelloRoutes(use, { mode })), "/api/hello")
}

describe("GET /api/hello", () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it("reports the personal edition before any loadEdition runs", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).edition).toBe("personal")
  })

  it("reports the installed edition by name", () => {
    installFakeEdition({})
    const handler = register("standalone")
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    expect(JSON.parse(res._getData()).edition).toBe("team")
  })

  it("signs in with the network password and never asks for setup in personal edition", () => {
    const handler = register()
    const { req, res, next } = createMockReqRes("GET")
    mockedGetConfig.mockReturnValueOnce(null)

    handler(req, res, next)

    const body = JSON.parse(res._getData())
    expect(body.edition).toBe("personal")
    expect(body.signIn).toBe("password")
    expect(body.setupRequired).toBe(false)
  })

  it("signs in with an account, and reports its setup, when the edition owns sign-in", () => {
    let setupRequired = true
    installFakeEdition({ auth: fakeEditionAuth(), setupRequired: () => setupRequired })
    const handler = register("standalone")
    const read = () => {
      const { req, res, next } = createMockReqRes("GET")
      mockedGetConfig.mockReturnValueOnce(null)
      handler(req, res, next)
      return JSON.parse(res._getData())
    }

    expect(read()).toMatchObject({ signIn: "account", setupRequired: true })
    setupRequired = false
    expect(read()).toMatchObject({ signIn: "account", setupRequired: false })
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
