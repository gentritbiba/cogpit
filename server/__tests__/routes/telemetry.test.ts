// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerTelemetryRoutes } from "../../routes/telemetry"
import { telemetryFeatures } from "../../telemetry/features"
import { __flushTelemetryForTest, startTelemetry, stopTelemetry } from "../../telemetry"

let dataDir: string
let fetchMock: ReturnType<typeof vi.fn>
const handler = getRouteHandler(collectRoutes(registerTelemetryRoutes), "/api/telemetry/feature")

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const { req, res, next, sendBody } = createMockReqRes(method, url, { body: body === undefined ? undefined : JSON.stringify(body), headers })
  handler(req, res, next)
  sendBody()
  await vi.waitFor(() => expect(res.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0))
  return { status: res._getStatus(), next }
}

async function features(): Promise<Array<Record<string, unknown>>> {
  await __flushTelemetryForTest()
  return fetchMock.mock.calls
    .flatMap((c) => (JSON.parse(((c as unknown[])[1] as { body: string }).body) as { batch: Array<{ event: string; properties: Record<string, unknown> }> }).batch)
    .filter((event) => event.event === "feature.used")
    .map((event) => event.properties)
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cogpit-telemetry-route-"))
  fetchMock = vi.fn(async () => new Response("{}"))
  await startTelemetry({
    dataDir,
    shell: "standalone",
    distribution: "npm",
    edition: "personal",
    freshInstall: false,
    development: false,
    env: {},
    fetch: fetchMock as unknown as typeof fetch,
    readDailyUsage: vi.fn(),
  })
})

afterEach(async () => {
  await stopTelemetry()
  await rm(dataDir, { recursive: true, force: true })
})

describe("POST /api/telemetry/feature", () => {
  it("counts renderer features from the fixed list only", async () => {
    expect((await call("POST", "/", { feature: "panel.browser" }, { "user-agent": "Mozilla/5.0 Electron/39" })).status).toBe(200)
    expect((await call("POST", "/", { feature: "anything/else" })).status).toBe(400)
    expect(await features()).toEqual([expect.objectContaining({ feature: "panel.browser", client: "desktop" })])
  })

  it("passes on other methods and paths", async () => {
    expect((await call("GET", "/")).next).toHaveBeenCalled()
    expect((await call("POST", "/other")).next).toHaveBeenCalled()
  })
})

describe("telemetryFeatures", () => {
  function request() {
    const mock = createMockReqRes("POST", "/shares", { headers: { "user-agent": "Mozilla/5.0" } })
    Object.assign(mock.req, { originalUrl: "/api/shares" })
    return mock
  }

  it("counts a mapped request once it succeeds, and only then", async () => {
    const refused = request()
    telemetryFeatures(refused.req, refused.res, refused.next)
    expect(refused.next).toHaveBeenCalled()
    refused.res.statusCode = 403
    refused.res.emit("finish")
    expect(await features()).toEqual([])

    const ok = request()
    telemetryFeatures(ok.req, ok.res, ok.next)
    ok.res.emit("finish")
    expect(await features()).toEqual([expect.objectContaining({ feature: "share.create", client: "browser" })])
  })
})
