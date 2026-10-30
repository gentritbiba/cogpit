// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { registerWorktreeSetupRoutes } from "../../routes/worktree-setup"
import { __resetEditionForTest, PERSONAL_EDITION } from "../../edition"
import { installFakeEdition } from "../edition/fakeEdition"
import { gitOutput } from "../../worktreeSetup/project"
import { getDataRoot, setDataRoot } from "../../config"
import { setRequestPrincipal } from "../../requestPrincipal"
import type { WorktreeSetupSnapshot } from "../../../shared/contracts/worktreeSetup"
import { assertSetupAccess } from "../../worktreeSetup/authorization"

vi.mock("../../lib/durableSend", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  refreshExecutionRequest: (request: unknown) => request,
}))

let root: string, cwd: string, previousRoot: string, base: string, server: Server
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "setup-routes-")); cwd = join(root, "project"); await mkdir(cwd)
  await gitOutput(cwd, ["init"])
  previousRoot = getDataRoot(); setDataRoot(root)
  registerWorktreeSetupRoutes((_path, handler) => {
    server = createServer((req, res) => {
      setRequestPrincipal(req, { userId: String(req.headers["x-test-user"] ?? "user-a"), username: "fixture", role: "admin" })
      void handler(req, res, () => { res.statusCode = 404; res.end() })
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address")
  base = `http://127.0.0.1:${address.port}/?cwd=${encodeURIComponent(cwd)}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); __resetEditionForTest(); setDataRoot(previousRoot); await rm(root, { recursive: true, force: true }) })
function put(body: unknown) { return fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }
it("requires trust and scopes recipe/config/output to the current account", async () => {
  expect((await put({ command: "echo untrusted" })).status).toBe(400)
  expect((await put({ command: "echo configured", trusted: true })).status).toBe(200)
  expect(((await (await fetch(base)).json()) as WorktreeSetupSnapshot).recipe?.command).toBe("echo configured")
  expect(((await (await fetch(base, { headers: { "x-test-user": "user-b" } })).json()) as WorktreeSetupSnapshot).recipe).toBeNull()
  expect((await put({ command: "" })).status).toBe(200)
  expect(((await (await fetch(base)).json()) as WorktreeSetupSnapshot).recipe).toBeNull()
})
it("refuses access before touching project paths when host execution capability is revoked", async () => {
  installFakeEdition({ me: () => ({ ...PERSONAL_EDITION.me({} as never), capabilities: { ...PERSONAL_EDITION.me({} as never).capabilities, terminal: false } }) })
  expect((await put({ command: "echo forbidden", trusted: true })).status).toBe(403)
  expect((await fetch(base)).status).toBe(403)
})
it("rechecks authority at command/prompt time rather than retaining a successful route decision", () => {
  const request = { headers: {} } as never
  expect(() => assertSetupAccess(request)).not.toThrow()
  installFakeEdition({ me: () => ({ ...PERSONAL_EDITION.me(request), capabilities: { ...PERSONAL_EDITION.me(request).capabilities, hostFiles: false } }) })
  expect(() => assertSetupAccess(request)).toThrow("Current host-file")
})
it("rejects action ids outside the authorized project history", async () => {
  const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: "foreign-operation", action: "cancel" }) })
  expect(response.status).toBe(409)
})
