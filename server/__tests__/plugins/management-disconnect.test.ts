// @vitest-environment node
import { createHash } from "node:crypto"
import { once } from "node:events"
import { Agent, createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Socket } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const gate = vi.hoisted(() => ({ hook: undefined as undefined | ((step: string) => Promise<void> | void) }))
vi.mock("../../config", () => ({ getConfig: () => ({ networkAccess: false }) }))
vi.mock("../../agents", () => ({ allStores: () => [] }))
vi.mock("../../plugins/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/store")>()
  return { ...actual, openPluginStore: (root: string, options: import("../../plugins/store").PluginStoreOptions) => actual.openPluginStore(root, { ...options, crashHook: (step) => gate.hook?.(step) }) }
})

import { authMiddleware, revokeAllSessions } from "../../security"
import { editionAuthz } from "../../edition"
import type { Middleware } from "../../http"
import { registerPluginRoutes } from "../../routes/plugins"
import { initializePluginManager, type PluginManager } from "../../plugins/manager"
import { PLUGIN_SESSION_HEADER } from "../../plugins/authorization"
import { createAuthority, createRoot, type Authority } from "./fixtures/signing"
import { client, signedPackage, type SignedPackage } from "./fixtures/storeSigning"
import type { PluginInstallPreview, PluginStoreSnapshot } from "../../../shared/contracts/plugins"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
interface Exchange { path: string; req: IncomingMessage; res: ServerResponse; socket: Socket; done: ReturnType<typeof deferred<void>> }
interface Reply { status: number; bytes: Buffer }
let directory: string
let manager: PluginManager
let server: Server
let agent: Agent
let port: number
let authority: Authority
let session: string
let exchanges: Exchange[]
let releasePause: (() => void) | undefined

function send(method: string, path: string, body?: Buffer | object, extraHeaders: Record<string, string> = {}) {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const req = request({ host: "127.0.0.1", port, agent, method, path: `/api/plugins${path}`, headers: {
    "Content-Length": String(bytes.length), "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json",
    ...(session ? { [PLUGIN_SESSION_HEADER]: session } : {}), ...extraHeaders,
  } })
  const reply = new Promise<Reply>((resolve, reject) => {
    req.once("error", reject)
    req.once("response", (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.once("error", reject)
      res.once("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(chunks) }))
    })
  })
  req.end(bytes)
  return { req, reply }
}
function body<T>(reply: Reply): T { return JSON.parse(reply.bytes.toString("utf8")) as T }
async function prepare(candidate: SignedPackage): Promise<PluginInstallPreview> {
  const staged = await send("POST", "/stage", candidate.bytes, { "X-Cogpit-Plugin-Client": JSON.stringify(client), "X-Cogpit-Plugin-Scope": '{"type":"all"}' }).reply
  expect(staged.status).toBe(200)
  const preview = body<PluginInstallPreview>(staged)
  expect((await send("GET", `/payload/${preview.transactionId}`).reply).bytes).toEqual(candidate.payload)
  expect((await send("POST", `/transactions/${preview.transactionId}/trial`).reply).status).toBe(200)
  return preview
}
async function commit(preview: PluginInstallPreview): Promise<Reply> {
  return send("POST", `/transactions/${preview.transactionId}/commit`, { expectedRevision: preview.registryRevision }).reply
}
function pausePublication() {
  const reached = deferred<void>(), released = deferred<void>()
  releasePause = () => released.resolve()
  gate.hook = async (step) => {
    if (step !== "commit-registry:file-synced") return
    reached.resolve()
    await released.promise
  }
  return { reached: reached.promise, release: releasePause }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cogpit-plugin-http-"))
  gate.hook = undefined; releasePause = undefined; exchanges = []; session = ""
  vi.stubEnv("COGPIT_DISABLE_PLUGINS", "0")
  manager = await initializePluginManager(directory)
  let handler!: Middleware
  registerPluginRoutes((_path, route) => { handler = route })
  server = createServer((req, res) => {
    const exchange = { path: req.url!, req, res, socket: req.socket, done: deferred<void>() }
    exchanges.push(exchange)
    authMiddleware(req, res, () => editionAuthz(req, res, () => {
      req.url = req.url!.slice("/api/plugins".length)
      void Promise.resolve(handler(req, res, () => {})).finally(() => exchange.done.resolve())
    }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture HTTP port")
  port = address.port; agent = new Agent({ keepAlive: true })
  const created = await send("POST", "/session").reply
  expect(created.status).toBe(200)
  session = body<{ sessionId: string }>(created).sessionId
  authority = createAuthority()
  const root = createRoot(authority)
  expect((await send("POST", "/publishers", { publisher: "dev-test", label: "Fixture developer", development: true, root: root.toString("utf8"), fingerprint: createHash("sha256").update(root).digest("hex") }).reply).status).toBe(200)
})
afterEach(async () => {
  releasePause?.()
  gate.hook = undefined
  agent?.destroy()
  server?.closeAllConnections()
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await manager?.close()
  await revokeAllSessions()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe("plugin commit connection lifetime over real HTTP", () => {
  it("retains the previous version when the coordinator disconnects before registry publication", async () => {
    const first = signedPackage(authority)
    expect((await commit(await prepare(first))).status).toBe(200)
    const second = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [first] })
    const preview = await prepare(second)
    const oldRevision = manager.snapshot().revision
    const pause = pausePublication()
    const committing = send("POST", `/transactions/${preview.transactionId}/commit`, { expectedRevision: preview.registryRevision })
    const failedConnection = committing.reply.catch((error: unknown) => error)
    await pause.reached
    const exchange = exchanges.at(-1)!
    try {
      expect(exchange.req.complete).toBe(true)
      expect(exchange.req.readableEnded).toBe(true)
      expect(exchange.req.aborted).toBe(false)
      expect(exchange.socket.destroyed).toBe(false)
      const closed = once(exchange.res, "close")
      committing.req.destroy(new Error("Fixture coordinator disconnected"))
      await closed
      expect(await failedConnection).toBeInstanceOf(Error)
      expect(exchange.req.aborted).toBe(false)
      expect(exchange.socket.destroyed).toBe(true)
      expect(exchange.res.destroyed).toBe(true)
    } finally { pause.release() }
    await exchange.done.promise
    expect(manager.snapshot()).toMatchObject({ available: true, revision: oldRevision, plugins: [{ selectedDigest: first.digest, enabled: true }] })
    const disk = JSON.parse(await readFile(join(directory, "runtime-plugins", "registry.json"), "utf8"))
    expect(disk.revision).toBe(oldRevision)
    expect(disk.plugins[first.manifest.id].selectedDigest).toBe(first.digest)
    await manager.close()
    manager = await initializePluginManager(directory)
    expect(manager.snapshot()).toMatchObject({ available: true, revision: oldRevision, plugins: [{ selectedDigest: first.digest, enabled: true }] })
  })

  it("commits a fully consumed request while its response connection remains live", async () => {
    const first = signedPackage(authority)
    expect((await commit(await prepare(first))).status).toBe(200)
    const second = signedPackage(authority, { version: "1.1.0", metadataVersion: 2, retained: [first] })
    const preview = await prepare(second)
    const pause = pausePublication()
    const committing = commit(preview)
    await pause.reached
    const exchange = exchanges.at(-1)!
    try {
      expect(exchange.req.complete).toBe(true)
      expect(exchange.req.readableEnded).toBe(true)
      expect(exchange.req.destroyed).toBe(true)
      expect(exchange.req.aborted).toBe(false)
      expect(exchange.socket.destroyed).toBe(false)
      expect(exchange.res.destroyed).toBe(false)
    } finally { pause.release() }
    const completed = await committing
    expect(completed.status).toBe(200)
    expect(body<PluginStoreSnapshot>(completed)).toMatchObject({ available: true, revision: preview.registryRevision + 1, plugins: [{ selectedDigest: second.digest, enabled: true }] })
  })
})
