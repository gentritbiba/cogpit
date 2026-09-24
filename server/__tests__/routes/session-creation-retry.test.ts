// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { getDataRoot, setDataRoot } from "../../config"
import { setRequestPrincipal } from "../../requestPrincipal"

const { start } = vi.hoisted(() => ({ start: vi.fn() }))
vi.mock("../../agents/runtimes", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runtimeFor: () => ({ descriptor: { displayName: "Test agent" }, start }),
}))
import { registerCreateAndSendRoute } from "../../routes/session-new/sessionSpawner"

const codexProject = (cwd: string) => descriptorFor("codex").dirName.encode(cwd)

describe("POST /api/create-and-send requestId", () => {
  let server: Server
  let base: string
  let directory: string
  let previousRoot: string
  /** The folder the session starts in, which has to exist. */
  const projectDir = mkdtempSync(join(tmpdir(), "cogpit-retry-project-"))
  const body = {
    requestId: "retry-test-123",
    dirName: codexProject(projectDir),
    message: "Do the work",
  }

  afterAll(() => rmSync(projectDir, { recursive: true, force: true }))

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cogpit-retry-route-"))
    previousRoot = getDataRoot()
    setDataRoot(directory)
    start.mockReset().mockImplementation(async () => ({
      sessionId: `session-${start.mock.calls.length}`,
      dirName: body.dirName,
      fileName: "session.jsonl",
      filePath: "/tmp/session.jsonl",
      initialContent: "first line\nsecond line",
    }))
    registerCreateAndSendRoute((_path, handler) => {
      server = createServer((req, res) => {
        setRequestPrincipal(req, { userId: String(req.headers["x-test-user"] ?? "user-1"), username: "test", role: "admin" })
        void handler(req, res, () => { res.statusCode = 404; res.end() })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Server has no port")
    base = `http://127.0.0.1:${address.port}/api/create-and-send`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    setDataRoot(previousRoot)
    await rm(directory, { recursive: true, force: true })
  })

  function post(payload: unknown, user = "user-1") {
    return fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify(payload) })
  }

  it("returns the same session and valid JSON to simultaneous retries", async () => {
    const responses = await Promise.all([post(body), post(body)])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const values = await Promise.all(responses.map((response) => response.json()))
    expect(values[0]).toEqual(values[1])
    expect(values[0]).toMatchObject({ requestId: body.requestId, initialContent: "first line\nsecond line" })
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0][0]).not.toHaveProperty("requestId")
    expect(await (await post(body)).json()).toEqual(values[0])
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("rejects conflicting retries without starting another agent", async () => {
    await post(body)
    const response = await post({ ...body, message: "Changed task" })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "CONFLICT" })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("keeps users separate and allows deliberate unkeyed launches", async () => {
    await post(body)
    await post(body, "user-2")
    const unkeyed = { dirName: body.dirName, message: body.message }
    await post(unkeyed)
    await post(unkeyed)
    expect(start).toHaveBeenCalledTimes(4)
  })

  it("refuses a folder that does not exist before invoking the runtime", async () => {
    const missing = join(projectDir, "deleted-since")
    const response = await post({ ...body, dirName: codexProject(missing) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: `The folder ${missing} does not exist`, code: "INVALID_REQUEST" })
    expect(start).not.toHaveBeenCalled()
  })

  it("refuses a file in place of a folder before invoking the runtime", async () => {
    const file = join(projectDir, "notes.txt")
    writeFileSync(file, "not a folder")
    const response = await post({ ...body, dirName: codexProject(file) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: `${file} is not a folder`, code: "INVALID_REQUEST" })
    expect(start).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === "win32")("starts a Codex session reached through a symlink in the resolved folder", async () => {
    const link = join(projectDir, "codex-link")
    symlinkSync(realpathSync(projectDir), link)
    const response = await post({ dirName: codexProject(link), message: body.message })
    expect(response.status).toBe(200)
    const real = realpathSync(projectDir)
    expect(start.mock.calls[0][0]).toMatchObject({ cwd: real, dirName: codexProject(real) })
  })

  it.skipIf(process.platform === "win32")("files a Claude session reached through a symlink under the resolved folder", async () => {
    const claude = descriptorFor("claude").dirName
    const link = join(projectDir, "claude-link")
    symlinkSync(realpathSync(projectDir), link)
    const response = await post({ dirName: claude.encode(link), cwd: link, message: body.message })
    expect(response.status).toBe(200)
    const real = realpathSync(projectDir)
    expect(start.mock.calls[0][0]).toMatchObject({ cwd: real, dirName: claude.encode(real) })
  })

  it.skipIf(process.platform === "win32")("refuses a dangling symlink with the path the caller asked for", async () => {
    const link = join(projectDir, "dangling-link")
    symlinkSync(join(projectDir, "never-created"), link)
    const response = await post({ ...body, dirName: codexProject(link) })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: `The folder ${link} does not exist`, code: "INVALID_REQUEST" })
    expect(start).not.toHaveBeenCalled()
  })

  it("rejects malformed request IDs before invoking the runtime", async () => {
    const response = await post({ ...body, requestId: 123 })
    expect(response.status).toBe(400)
    expect(start).not.toHaveBeenCalled()
  })
})
