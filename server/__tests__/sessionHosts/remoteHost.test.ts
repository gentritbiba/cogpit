// @vitest-environment node
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const origins = vi.hoisted(() => new Map<string, { deviceId?: string; parentSessionId?: string }>())
vi.mock("../../lib/sessionOrigins", () => ({
  sessionOrigin: async (id: string) => origins.get(id) ?? null,
  recordSessionOrigin: async (id: string, origin: { deviceId?: string }) => {
    origins.set(id, { ...origins.get(id), ...origin })
  },
}))
vi.mock("../../sessionHosts/localHost", () => ({
  localHost: { id: "local", name: "this machine", remote: false, has: async () => false },
}))

import { addDevice, initDeviceRegistry, removeDevice, listDevices } from "../../hub/registry"
import { hostForSession, hostNamed, waitAcrossHosts } from "../../sessionHosts"
import { createRemoteHost } from "../../sessionHosts/remoteHost"

interface Seen {
  method: string
  url: string
  headers: IncomingMessage["headers"]
  body: unknown
}

type Handler = (req: Seen, res: ServerResponse) => void

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

async function fakeDevice(handler: Handler, options: { sessionApi?: number } = {}) {
  const seen: Seen[] = []
  let tokens = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      const entry = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
      if (entry.url === "/api/auth/verify") return send(res, 200, { valid: true, token: `token-${++tokens}` })
      if (entry.url === "/api/hello") return send(res, 200, { app: "cogpit", version: "9.9.9", sessionApi: options.sessionApi ?? 1 })
      seen.push(entry)
      handler(entry, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const device = await addDevice({ name: `box-${port}`, host: "127.0.0.1", port, auth: "password", password: "hunter2secret1" })
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await removeDevice(device.id)
  })
  return { device, seen, port }
}

let registryDir: string
const cleanup: (() => Promise<void>)[] = []

beforeEach(async () => {
  registryDir = await mkdtemp(join(tmpdir(), "cogpit-remote-host-"))
  await initDeviceRegistry(registryDir)
  origins.clear()
})

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  await rm(registryDir, { recursive: true, force: true })
})

const state = (sessionId: string, outcome: string) => ({ sessionId, outcome, live: true, running: false, waiting: [] })

describe("remote session host", () => {
  it("returns null for an absent durable receipt so a first answer can proceed", async () => {
    const { device } = await fakeDevice((_req, res) => send(res, 404, { error: "Command not found" }), { sessionApi: 2 })
    await expect(createRemoteHost(device.id).receipt!("first-answer")).resolves.toBeNull()
  })

  it("keeps receipt access and unknown-device errors visible", async () => {
    const { device } = await fakeDevice((_req, res) => send(res, 403, { error: "Access denied" }), { sessionApi: 2 })
    await expect(createRemoteHost(device.id).receipt!("answer")).rejects.toMatchObject({ status: 403 })
    await removeDevice(device.id)
    await expect(createRemoteHost(device.id).receipt!("answer")).rejects.toMatchObject({ code: "UNKNOWN_DEVICE" })
  })
  it("creates through the device with its token and asks it to answer for itself", async () => {
    const { device, seen } = await fakeDevice((_req, res) => send(res, 200, { sessionId: "s1", dirName: "-home-app" }))
    const host = createRemoteHost(device.id)
    expect(await host.create({ cwd: "/home/app", message: "hi", mode: "bypassPermissions", requestId: "req-1", scope: "local" }))
      .toEqual({ sessionId: "s1", dirName: "-home-app" })
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/api/create-and-send",
      body: { cwd: "/home/app", message: "hi", permissions: { mode: "bypassPermissions" }, requestId: "req-1" },
    })
    expect(seen[0].headers.authorization).toBe("Bearer token-1")
    expect(seen[0].headers["x-cogpit-session-scope"]).toBe("local")
    expect(seen[0].headers["x-cogpit-client"]).toBe("1")
  })

  it("re-mints a rejected token once and replays the call", async () => {
    let calls = 0
    const { device, seen } = await fakeDevice((_req, res) => {
      if (++calls === 1) return send(res, 401, { error: "expired" })
      send(res, 200, state("s1", "completed"))
    })
    expect((await createRemoteHost(device.id).state("s1")).outcome).toBe("completed")
    expect(seen.map((entry) => entry.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2"])
  })

  it("reads a missing session as not found and a silent device as unreachable", async () => {
    const { device } = await fakeDevice((_req, res) => send(res, 404, { error: "Session not found" }))
    const host = createRemoteHost(device.id)
    expect((await host.state("gone")).outcome).toBe("not_found")
    expect(await host.result("gone")).toBeNull()
    expect(await host.has("gone")).toBe(false)

    const dead = await addDevice({ name: "dead", host: "127.0.0.1", port: 1, auth: "none" })
    cleanup.push(async () => { await removeDevice(dead.id) })
    const deadState = await createRemoteHost(dead.id).state("s1")
    expect(deadState).toMatchObject({ outcome: "unreachable", error: expect.stringContaining("Could not reach") })
  })

  it("refuses a device too old to run sessions", async () => {
    const { device } = await fakeDevice((_req, res) => send(res, 200, {}), { sessionApi: 0 })
    await expect(createRemoteHost(device.id).state("s1")).rejects.toMatchObject({ code: "DEVICE_TOO_OLD" })
  })

  it("passes the device's own error through", async () => {
    const { device } = await fakeDevice((_req, res) => send(res, 404, { error: "No pending request with that id", code: "NOT_FOUND" }))
    await expect(createRemoteHost(device.id).respond("s1", "r1", { decision: "allow" }))
      .rejects.toMatchObject({ status: 404, message: "No pending request with that id" })
  })

  it("long-polls the device and reports its sessions unreachable once the deadline passes", async () => {
    const { device, seen } = await fakeDevice((_req, res) => send(res, 200, { timedOut: false, sessions: [state("s1", "completed")] }))
    const host = createRemoteHost(device.id)
    expect(await host.wait(["s1"], { mode: "all", timeoutMs: 30_000 })).toEqual({
      timedOut: false,
      sessions: [state("s1", "completed")],
    })
    expect(seen[0].body).toMatchObject({ sessionIds: ["s1"], mode: "all" })

    const dead = await addDevice({ name: "dead", host: "127.0.0.1", port: 1, auth: "none" })
    cleanup.push(async () => { await removeDevice(dead.id) })
    const result = await createRemoteHost(dead.id).wait(["s2"], { mode: "all", timeoutMs: 50 })
    expect(result.timedOut).toBe(true)
    expect(result.sessions[0].outcome).toBe("unreachable")
  })
})

describe("session host resolution", () => {
  it("finds an unknown session on whichever device holds it, then remembers", async () => {
    const empty = await fakeDevice((_req, res) => send(res, 404, { error: "Session not found" }))
    const holder = await fakeDevice((req, res) => send(res, 200, state(req.url.split("/").pop()!, "running")))
    const host = await hostForSession("s1")
    expect(host.id).toBe(holder.device.id)
    expect(origins.get("s1")).toEqual({ deviceId: holder.device.id })
    expect(empty.seen.length).toBeGreaterThan(0)

    holder.seen.length = 0
    expect((await hostForSession("s1")).id).toBe(holder.device.id)
    expect(holder.seen).toEqual([])
  })

  it("names devices by id, name or host and lists the known ones when none matches", async () => {
    const { device } = await fakeDevice((_req, res) => send(res, 404, {}))
    expect(hostNamed(device.name.toUpperCase()).id).toBe(device.id)
    expect(hostNamed(device.id).id).toBe(device.id)
    expect(hostNamed("local").remote).toBe(false)
    expect(() => hostNamed("nowhere")).toThrow(listDevices()[0].name)
  })

  it("waits on several machines at once, and --any stops at the first settled one", async () => {
    const fast = await fakeDevice((_req, res) => send(res, 200, { timedOut: false, sessions: [state("a", "completed")] }))
    const slow = await fakeDevice((req, res) => {
      if (req.url === "/api/session-wait") return // never answers; the hub cancels it
      send(res, 200, state("b", "running"))
    })
    const result = await waitAcrossHosts([
      { host: createRemoteHost(fast.device.id), sessionId: "a" },
      { host: createRemoteHost(slow.device.id), sessionId: "b" },
    ], { mode: "any", timeoutMs: 30_000 })
    expect(result).toEqual({ timedOut: false, sessions: [state("a", "completed"), state("b", "running")] })
  })
})
