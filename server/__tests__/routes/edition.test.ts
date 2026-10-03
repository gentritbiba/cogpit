// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { ALL_CAPABILITIES } from "../../../shared/contracts/identity"
import { __resetEditionForTest } from "../../edition"
import { registerEditionRoutes } from "../../routes/edition"
import { installFakeEdition } from "../edition/fakeEdition"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

afterEach(() => __resetEditionForTest())

describe("edition routes", () => {
  it("reports the personal identity with full capabilities", async () => {
    const handler = getRouteHandler(collectRoutes(registerEditionRoutes), "/api/me")
    const { req, res, next } = createMockReqRes("GET", "/")

    await handler(req, res, next)

    expect(res._getStatus()).toBe(200)
    expect(JSON.parse(res._getData())).toEqual({
      authenticated: true,
      edition: "personal",
      user: null,
      capabilities: ALL_CAPABILITIES,
    })
  })

  it("calls next for non-GET methods", async () => {
    const handler = getRouteHandler(collectRoutes(registerEditionRoutes), "/api/me")
    const { req, res, next } = createMockReqRes("POST", "/")
    await handler(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it("registers the running edition's own routes after /api/me", () => {
    const paths: string[] = []
    installFakeEdition({ registerRoutes: (use) => use("/api/widgets", () => {}) })
    registerEditionRoutes((path) => paths.push(path))
    expect(paths).toEqual(["/api/me", "/api/widgets"])
  })
})
