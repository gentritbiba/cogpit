// @vitest-environment node
import http from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sendJsonWithEtag } from "../../lib/jsonEtag"
import { createHubProxyHandler } from "../../hub/proxy"
import { addDevice, initDeviceRegistry } from "../../hub/registry"
import { createMockReqRes } from "../http-fixtures"

function send(body: unknown, ifNoneMatch?: string) {
  const { req, res } = createMockReqRes("GET", "/", { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} })
  sendJsonWithEtag(req, res, body)
  return { status: res._getStatus(), data: res._getData(), headers: res._getHeaders() }
}

describe("sendJsonWithEtag", () => {
  it("answers JSON with a weak ETag that changes with the body", () => {
    const first = send({ a: 1 })
    expect(first).toMatchObject({ status: 200, data: '{"a":1}', headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" } })
    expect(first.headers.ETag).toMatch(/^W\/"[\w-]+"$/)
    expect(send({ a: 1 }).headers.ETag).toBe(first.headers.ETag)
    expect(send({ a: 2 }).headers.ETag).not.toBe(first.headers.ETag)
  })

  it("answers a bodiless 304 when the client names the current tag, however it lists it", () => {
    const etag = send({ a: 1 }).headers.ETag!
    for (const header of [etag, etag.slice(2), `W/"old", ${etag}`, "*"]) {
      expect(send({ a: 1 }, header)).toMatchObject({ status: 304, data: "", headers: { ETag: etag } })
    }
    expect(send({ a: 2 }, etag)).toMatchObject({ status: 200, data: '{"a":2}' })
  })

  describe("through the hub's device proxy", () => {
    const servers: http.Server[] = []
    let registryDir: string
    const listen = (server: http.Server) => new Promise<number>((resolve) => {
      servers.push(server)
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
    })
    beforeAll(async () => {
      registryDir = await mkdtemp(join(tmpdir(), "cogpit-etag-hub-"))
      await initDeviceRegistry(registryDir)
    })
    afterAll(async () => {
      await Promise.all(servers.map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })))
      await rm(registryDir, { recursive: true, force: true })
    })

    it("passes If-None-Match to the device and its 304 and ETag back", async () => {
      const devicePort = await listen(http.createServer((req, res) => {
        req.resume()
        req.on("end", () => {
          if (req.url === "/api/auth/verify") {
            res.setHeader("Content-Type", "application/json")
            return res.end(JSON.stringify({ valid: true, token: "device-token" }))
          }
          sendJsonWithEtag(req, res, { counts: { total: 3 } })
        })
      }))
      const device = await addDevice({ name: "Etag box", host: "127.0.0.1", port: devicePort, auth: "password", password: "hunter2secret1" })
      const handler = createHubProxyHandler()
      const hubPort = await listen(http.createServer((req, res) => {
        if (req.url?.startsWith("/hub")) req.url = req.url.slice("/hub".length) || "/"
        handler(req, res, () => { res.statusCode = 599; res.end() })
      }))
      const url = `http://127.0.0.1:${hubPort}/hub/${device.id}/api/delegated-tasks?sessionId=s&view=counts`

      const first = await fetch(url)
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ counts: { total: 3 } })
      const etag = first.headers.get("etag")!
      expect(etag).toMatch(/^W\//)

      const unchanged = await fetch(url, { headers: { "If-None-Match": etag } })
      expect(unchanged.status).toBe(304)
      expect(unchanged.headers.get("etag")).toBe(etag)
      expect(await unchanged.text()).toBe("")
    })
  })
})
