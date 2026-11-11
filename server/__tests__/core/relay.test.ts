// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { WebSocket, WebSocketServer } from "ws"

import { relayToCore, type CoreSocketRelay } from "../../core/relay"
import { startCore, type CoreLease } from "../../core/supervisor"

let core: CoreLease
let server: Server
let wss: WebSocketServer
let origin: string
const relays: CoreSocketRelay[] = []

beforeAll(async () => {
  core = await startCore({ dataDir: tmpdir() })
  server = createServer()
  wss = new WebSocketServer({ server })
  wss.on("connection", (ws, req) => relays.push(relayToCore(ws, req, "/v1/diag/ws")))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const client of wss.clients) client.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await core.release()
})

function connect(): WebSocket {
  return new WebSocket(`${origin}/__test`)
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) => ws.once("message", (data, isBinary) => resolve({ data: data as Buffer, isBinary })))
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })))
}

describe("relayToCore", () => {
  it("relays text and binary frames both ways, including frames sent before core connected", async () => {
    const ws = connect()
    await new Promise((resolve) => ws.once("open", resolve))
    const first = nextMessage(ws)
    ws.send("hello")
    expect(await first).toEqual({ data: Buffer.from("hello"), isBinary: false })
    const second = nextMessage(ws)
    ws.send(Buffer.from([0, 1, 2, 255]))
    expect(await second).toEqual({ data: Buffer.from([0, 1, 2, 255]), isBinary: true })
    ws.close()
  })

  it("passes core's close code to the client", async () => {
    const ws = connect()
    await new Promise((resolve) => ws.once("open", resolve))
    const done = closed(ws)
    ws.send("close:4001:core said so")
    expect(await done).toEqual({ code: 4001, reason: "core said so" })
  })

  it("lets TS close the client with its own code", async () => {
    const ws = connect()
    await new Promise((resolve) => ws.once("open", resolve))
    const echoed = nextMessage(ws)
    ws.send("ready")
    await echoed
    const done = closed(ws)
    relays[relays.length - 1].close(1008, "Session revoked")
    expect(await done).toEqual({ code: 1008, reason: "Session revoked" })
  })
})
