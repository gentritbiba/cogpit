// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getDataRoot, setDataRoot } from "../../config"
import { __resetHostThemeForTest, getHostTheme } from "../../lib/appearance"
import { registerAppearanceRoutes } from "../../routes/appearance"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

const handler = getRouteHandler(collectRoutes(registerAppearanceRoutes), "/api/appearance")
const originalDataRoot = getDataRoot()
let dataDir: string

async function call(method: string, body?: unknown, url = "/") {
  const { req, res, next, sendBody } = createMockReqRes(method, url, {
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
  void handler(req, res, next)
  sendBody()
  await vi.waitFor(() => expect(res.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0))
  const data = res._getData()
  return { status: res._getStatus(), body: data ? JSON.parse(data) : undefined, next }
}

describe("/api/appearance", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "cogpit-appearance-"))
    setDataRoot(dataDir)
    __resetHostThemeForTest()
  })

  afterEach(async () => {
    setDataRoot(originalDataRoot)
    __resetHostThemeForTest()
    await rm(dataDir, { recursive: true, force: true })
  })

  it("reports no theme until someone picks one", async () => {
    expect(await call("GET")).toMatchObject({ status: 200, body: { theme: null } })
  })

  it("keeps the picked theme for every later reader", async () => {
    expect(await call("PUT", { theme: "oled" })).toMatchObject({ status: 200, body: { theme: "oled" } })
    expect(await call("GET")).toMatchObject({ status: 200, body: { theme: "oled" } })

    __resetHostThemeForTest()
    expect(getHostTheme()).toBe("oled")
    expect(JSON.parse(await readFile(join(dataDir, "appearance.local.json"), "utf-8"))).toEqual({ theme: "oled" })
    if (process.platform !== "win32") {
      expect((await stat(join(dataDir, "appearance.local.json"))).mode & 0o777).toBe(0o600)
    }
  })

  it("refuses a theme it does not know and keeps the current one", async () => {
    await call("PUT", { theme: "light" })
    expect(await call("PUT", { theme: "neon" })).toMatchObject({ status: 400 })
    expect(await call("PUT", "{not json")).toMatchObject({ status: 400 })
    expect(getHostTheme()).toBe("light")
  })

  it("reads a corrupt file as no theme", async () => {
    await writeFile(join(dataDir, "appearance.local.json"), "{")
    expect(getHostTheme()).toBeNull()
  })

  it("leaves other methods and deeper paths to later routes", async () => {
    expect((await call("POST", { theme: "dark" })).next).toHaveBeenCalled()
    expect((await call("GET", undefined, "/extra")).next).toHaveBeenCalled()
  })
})
