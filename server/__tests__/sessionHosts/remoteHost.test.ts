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
  localHost: { id: "local", name: "this machine", remote: false, has: async () => false, state: async (sessionId: string) => ({ sessionId, outcome: "completed", live: false, running: false, waiting: [] }) },
}))

import { addDevice, initDeviceRegistry, removeDevice, listDevices } from "../../hub/registry"
import { hostForSession, hostNamed, statesAcrossHosts, waitAcrossHosts } from "../../sessionHosts"
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

async function fakeDevice(handler: Handler, options: { sessionApi?: number; crewChat?: number } = {}) {
  const seen: Seen[] = []
  let tokens = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      const entry = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
      if (entry.url === "/api/auth/verify") return send(res, 200, { valid: true, token: `token-${++tokens}` })
      if (entry.url === "/api/hello") return send(res, 200, { app: "cogpit", version: "9.9.9", sessionApi: options.sessionApi ?? 1, crewChat: options.crewChat ?? 0 })
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
  it("refuses notifications on old devices before sending any message", async () => {
    const { device, seen } = await fakeDevice((_req, res) => send(res, 200, {}), { sessionApi: 2 })
    await expect(createRemoteHost(device.id).send("s1", "Notice", { commandId: "notification-old-device", notification: true, onlyWhileRunning: true, intent: "steer" }))
      .rejects.toMatchObject({ status: 426, code: "DEVICE_TOO_OLD" })
    expect(seen).toEqual([])
  })

  it("preserves notification and idle guards when sending to a compatible device", async () => {
    const { device, seen } = await fakeDevice((_req, res) => send(res, 200, { delivery: "queued" }), { sessionApi: 2, crewChat: 1 })
    await createRemoteHost(device.id).send("s1", "Notice", { commandId: "notification-current-device", notification: true, onlyWhileRunning: true, intent: "steer" })
    expect(seen[0]).toMatchObject({ url: "/api/session-send", body: { sessionId: "s1", message: "Notice", notification: true, onlyWhileRunning: true, intent: "steer" } })
  })

  it("reads and changes a device session's queue, and asks a stop to cancel what still waits", async () => {
    const commands = [{ id: "held-message", state: "held" }]
    const { device, seen } = await fakeDevice((req, res) => send(res, 200, req.url === "/api/stop-session" ? { success: true } : { commands }), { sessionApi: 2 })
    const host = createRemoteHost(device.id)
    expect(await host.queue!("s1", null)).toEqual(commands)
    await host.queue!("s1", { action: "resume" })
    expect(await host.stop("s1")).toBe(true)
    expect(seen.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: "GET", url: "/api/session-commands?sessionId=s1", body: undefined },
      { method: "POST", url: "/api/session-commands", body: { action: "resume", sessionId: "s1" } },
      { method: "POST", url: "/api/stop-session", body: { sessionId: "s1", cancelQueued: true } },
    ])
  })

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

  it("reads states across machines, asking a device that fails only once (2026-11-07 23:02, e59cd71c)", async () => {
    const dead = await fakeDevice((_req, res) => send(res, 530, { error: "Origin unreachable" }))
    const alive = await fakeDevice((req, res) => send(res, 200, state(req.url.split("/").pop()!, "running")))
    const { localHost } = await import("../../sessionHosts/localHost")
    const deadHost = createRemoteHost(dead.device.id)
    const states = await statesAcrossHosts([
      { host: localHost, sessionId: "here" },
      ...["d1", "d2", "d3"].map((sessionId) => ({ host: deadHost, sessionId })),
      { host: createRemoteHost(alive.device.id), sessionId: "a1" },
    ])
    expect(states.map(({ sessionId, outcome }) => [sessionId, outcome])).toEqual([["here", "completed"], ["d1", "unreachable"], ["d2", "unreachable"], ["d3", "unreachable"], ["a1", "running"]])
    expect(new Set(states.slice(1, 4).map((entry) => entry.error)).size).toBe(1)
    expect(states[1]!.error).toBeTruthy()
    expect(dead.seen.filter((entry) => entry.url.startsWith("/api/session-status/"))).toHaveLength(1)
  })
})
