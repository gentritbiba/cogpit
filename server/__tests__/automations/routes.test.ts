// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"

const caps = vi.hoisted(() => ({ hostFiles: true, terminal: true }))
vi.mock("../../edition", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../edition")>()
  return { ...original, editionModule: () => ({ ...original.editionModule(), me: () => ({ capabilities: caps }) }) }
})
vi.mock("../../automations/handler", () => ({ registerAutomationHandler: () => {} }))
vi.mock("../../automations/service", async (importOriginal) => ({ ...await importOriginal<Record<string, unknown>>(), listTasks: () => [] }))

import { registerAutomationRoutes } from "../../routes/automations"

let server: Server
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })

async function list(): Promise<number> {
  registerAutomationRoutes((path, handler) => {
    if (path !== "/api/automations") return
    server = createServer((req, res) => { req.url = req.url!.replace(/^\/api\/automations/, "") || "/"; void handler(req, res, () => res.end()) })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  return (await fetch(`http://127.0.0.1:${address.port}/api/automations`)).status
}

describe("automation management routes", () => {
  it("need host-file and terminal access, checked on every request", async () => {
    expect(await list()).toBe(200)
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()))
    caps.terminal = false
    expect(await list()).toBe(403)
  })
})
