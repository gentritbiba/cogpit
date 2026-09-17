// @vitest-environment node
import { execFile } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { IncomingMessage, type ClientRequest } from "node:http"
import { createServer, request as httpsRequest, type RequestOptions } from "node:https"
import { Socket, type LookupFunction } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPluginHttpsTransport, HTTPS_RESPONSE_LIMIT, HttpsTransportError, isPublicAddress, type HttpsTransportDependencies, type PluginHttpsInput } from "../../plugins/httpsTransport"

const publicV4 = "93.184.216.34"
const secret = "fixture-secret-9ae816b7"
const input = (extra: Partial<PluginHttpsInput> = {}): PluginHttpsInput => ({ origin: "https://api.example.test", path: "/v1/resources?limit=5", credential: { header: "Authorization", scheme: "bearer", secret }, signal: new AbortController().signal, ...extra })
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture(options: { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; complete?: boolean; rawHeaders?: string[]; hang?: boolean } = {}) {
  const response = new IncomingMessage(new Socket())
  response.statusCode = options.status ?? 200
  response.headers = { "content-type": "application/json", ...options.headers }
  response.rawHeaders = options.rawHeaders ?? Object.entries(response.headers).flatMap(([name, value]) => [name, String(value)])
  response.complete = options.complete ?? true
  const outgoing = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() })
  const request = vi.fn<NonNullable<HttpsTransportDependencies["request"]>>((_options, receive) => {
    outgoing.end.mockImplementation(() => queueMicrotask(() => {
      receive(response)
      for (const chunk of options.chunks ?? [Buffer.from('{"ok":true}')]) response.push(chunk)
      if (!options.hang) response.push(null)
    }))
    return outgoing as unknown as ClientRequest
  })
  const lookup = vi.fn(async () => [{ address: publicV4, family: 4 }])
  const transport = createPluginHttpsTransport({ lookup, request })
  cleanup.push(() => { response.destroy(); outgoing.removeAllListeners() })
  return { transport, request, lookup, outgoing, response }
}

describe("plugin public address policy", () => {
  it.each(["0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.0.0.9", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "127.1", "0177.0.0.1", "0x7f000001", "2130706433"])("rejects private, special or ambiguous IPv4 %s", (address) => {
    expect(isPublicAddress(address, 4)).toBe(false)
  })
  it.each(["::", "::1", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:93.184.216.34", "::ffff:0:127.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1", "2001::1", "2001:2::1", "2001:20::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "2620:4f:8000::1", "fc00::1", "fd00::1", "fe80::1", "fe80::1%en0", "ff02::1", "4000::1"])("rejects private, mapped, transitional or reserved IPv6 %s", (address) => {
    expect(isPublicAddress(address, 6)).toBe(false)
  })
  it.each([[publicV4, 4], ["8.8.8.8", 4], ["2606:4700:4700::1111", 6], ["2001:4860:4860::8888", 6]] as const)("accepts ordinary global unicast %s", (address, family) => {
    expect(isPublicAddress(address, family)).toBe(true)
  })
  it("rejects family mismatches and malformed addresses", () => {
    expect(isPublicAddress(publicV4, 6)).toBe(false)
    expect(isPublicAddress("not-an-address", 4)).toBe(false)
    expect(isPublicAddress(publicV4, 0)).toBe(false)
  })
  it.each(["2001:4860::5efe:127.0.0.1", "2001:4860::200:5efe:93.184.216.34", "3ffe::1"])("rejects ISATAP and retired 6bone address %s", (address) => {
    expect(isPublicAddress(address, 6)).toBe(false)
  })
})

describe("bounded HTTPS request construction", () => {
  it.each(["http://api.example.test", "https://api.example.test/", "https://api.example.test:443", "https://api.example.test:8443", "https://user:password@api.example.test", "https://api.example.test/path", "https://api.example.test?x=1", "https://api.example.test#fragment", "https://127.0.0.1", "https://[::1]", "https://localhost", "https://host.local", "https://host.internal", "https://api.example.test."])("rejects noncanonical or nonpublic origins %s before DNS", async (origin) => {
    const test = fixture()
    await expect(test.transport(input({ origin }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(test.lookup).not.toHaveBeenCalled()
    expect(test.request).not.toHaveBeenCalled()
  })
  it.each(["//another.example/path", "https://another.example/path", "/v1/../secret", "/%2e%2e/secret", "/v1/%2fsecret", "/v1/%5csecret", "/v1/#fragment", "/v1/\r\nInjected: x", "/v1/%", "/" + "a".repeat(8192)])("rejects unsafe built path %s", async (path) => {
    const test = fixture()
    await expect(test.transport(input({ path }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    expect(test.request).not.toHaveBeenCalled()
  })
  it.each(["Host", "Cookie", "Content-Length", "X-Forwarded-Host", "X-HTTP-Method-Override", "X-Original-URL", "X-Rewrite-URL", "X-Key\r\nOther", "X-Key\n"])("rejects unsafe credential header %s", async (header) => {
    await expect(fixture().transport(input({ credential: { header, scheme: "raw", secret } }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })
  it.each(["", " secret", "secret ", "secret\nHeader: bad", "secret\n", "secret\u0000", "a".repeat(4097)])("rejects invalid credential bytes without exposing them", async (value) => {
    await expect(fixture().transport(input({ credential: { header: "X-API-Key", scheme: "raw", secret: value } }))).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Plugin HTTPS request failed: INVALID_REQUEST" })
  })
  it("rejects caller-supplied URL, headers, method or request options", async () => {
    for (const key of ["url", "headers", "method", "agent", "lookup", "rejectUnauthorized"]) {
      await expect(fixture().transport({ ...input(), [key]: "forged" } as PluginHttpsInput)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    }
  })
  it("allows safely encoded resource names but rejects double-decoded paths", async () => {
    const test = fixture()
    const path = "/v1/" + encodeURIComponent("API guide é?draft#part")
    expect(await test.transport(input({ path }))).toEqual({ ok: true })
    expect(test.request.mock.calls[0][0].path).toBe(path)
    await expect(test.transport(input({ path: "/v1/%252e%252e" }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })
  it.each(["raw", "bearer"] as const)("uses an exact destination and one %s credential header", async (scheme) => {
    const test = fixture({ headers: { "set-cookie": "not-for-the-ui", "x-debug": secret } })
    const data = await test.transport(input({ credential: { header: "X-API-Key", scheme, secret } }))
    expect(data).toEqual({ ok: true })
    const options = test.request.mock.calls[0][0]
    expect(options).toMatchObject({ protocol: "https:", hostname: "api.example.test", servername: "api.example.test", port: 443, method: "GET", path: "/v1/resources?limit=5", agent: false, family: 4, autoSelectFamily: false, rejectUnauthorized: true, maxHeaderSize: 16384,
      headers: { Accept: "application/json", "Accept-Encoding": "identity", "X-API-Key": scheme === "bearer" ? `Bearer ${secret}` : secret } })
    expect(Object.keys(options.headers!)).toHaveLength(3)
  })
  it("validates every DNS answer before connecting, even if the first is public", async () => {
    const test = fixture()
    test.lookup.mockResolvedValue([{ address: publicV4, family: 4 }, { address: "127.0.0.1", family: 4 }])
    await expect(test.transport(input())).rejects.toMatchObject({ code: "NETWORK_DENIED" })
    expect(test.request).not.toHaveBeenCalled()
  })
  it("pins the selected address and never repeats resolution during the socket lookup", async () => {
    const test = fixture()
    await test.transport(input())
    test.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }])
    const pinned = test.request.mock.calls[0][0].lookup!
    const one = vi.fn(), all = vi.fn()
    pinned("api.example.test", {}, one)
    pinned("api.example.test", { all: true }, all)
    expect(one).toHaveBeenCalledWith(null, publicV4, 4)
    expect(all).toHaveBeenCalledWith(null, [{ address: publicV4, family: 4 }])
    expect(test.lookup).toHaveBeenCalledOnce()
  })
  it("bounds DNS records and suppresses DNS errors", async () => {
    for (const addresses of [[], Array.from({ length: 65 }, () => ({ address: publicV4, family: 4 }))]) {
      const test = fixture(); test.lookup.mockResolvedValue(addresses)
      await expect(test.transport(input())).rejects.toMatchObject({ code: "NETWORK_DENIED" })
    }
    const test = fixture(); test.lookup.mockRejectedValue(new Error(secret))
    await expect(test.transport(input())).rejects.toMatchObject({ code: "UPSTREAM_FAILED", message: "Plugin HTTPS request failed: UPSTREAM_FAILED" })
  })
})

describe("hostile HTTPS responses", () => {
  it.each([301, 302, 303, 307, 308, 400, 401, 403, 500])("rejects upstream status %s without following redirects or exposing the body", async (status) => {
    const test = fixture({ status, headers: { location: "https://private.internal", "set-cookie": secret }, chunks: [Buffer.from(secret)] })
    await expect(test.transport(input())).rejects.toMatchObject({ code: "UPSTREAM_FAILED", message: "Plugin HTTPS request failed: UPSTREAM_FAILED" })
    expect(test.request).toHaveBeenCalledOnce()
    expect(test.response.destroyed).toBe(true)
  })
  it.each(["text/html", "text/plain", "application/json; charset=iso-8859-1", "application/json; boundary=anything"])("rejects non-JSON or unsupported content type %s", async (type) => {
    await expect(fixture({ headers: { "content-type": type } }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
  })
  it.each(["application/json", "application/problem+json", "application/json; charset=utf-8", 'application/json; charset="utf-8"'])("accepts bounded UTF-8 JSON media type %s", async (type) => {
    expect(await fixture({ headers: { "content-type": type } }).transport(input())).toEqual({ ok: true })
  })
  it.each(["gzip", "br", "deflate", "identity,gzip", "unknown"])("rejects content encoding %s without decompression", async (encoding) => {
    await expect(fixture({ headers: { "content-encoding": encoding } }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
  })
  it.each(['{"key":1,"key":2}', '{"key":1,"k\\u0065y":2}', '{"nested":{"a":1,"a":2}}', '{"x":1e999}', '{"x":"\\ud800"}', 'not-json'])("rejects malformed JSON with a static error", async (body) => {
    await expect(fixture({ chunks: [Buffer.from(body)] }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "Plugin HTTPS request failed: INVALID_RESPONSE" })
  })
  it.each([`{"key":"prefix ${secret} suffix"}`, `{"${secret}":1}`, `{"nested":[{"value":"Bearer ${secret}"}]}`, `{"${secret}":1,"${secret}":2}`, `{"key":"fixture-secret-9ae816b\\u0037"}`])("rejects secrets echoed in keys or values", async (body) => {
    await expect(fixture({ chunks: [Buffer.from(body)] }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "Plugin HTTPS request failed: INVALID_RESPONSE" })
  })
  it("rejects invalid UTF-8, excessive depth and duplicate critical response headers", async () => {
    await expect(fixture({ chunks: [Buffer.from([0xff])] }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    await expect(fixture({ chunks: [Buffer.from("[".repeat(17) + "0" + "]".repeat(17))] }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    await expect(fixture({ rawHeaders: ["Content-Type", "application/json", "Content-Type", "text/plain"] }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
  })
  it("enforces declared and streamed byte caps and detects incomplete responses", async () => {
    await expect(fixture({ headers: { "content-length": String(HTTPS_RESPONSE_LIMIT + 1) } }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    const test = fixture({ chunks: [Buffer.from('{"ok":'), Buffer.from("true}")] })
    await expect(test.transport(input({ maxBytes: 10 }))).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    expect(test.response.destroyed).toBe(true)
    await expect(fixture({ headers: { "content-length": "999" } }).transport(input())).rejects.toMatchObject({ code: "INVALID_RESPONSE" })
    await expect(fixture({ complete: false }).transport(input())).rejects.toBeInstanceOf(HttpsTransportError)
  })
  it("accepts realistic data beyond the former 32 KiB response budget", async () => {
    const value = { tasks: Array.from({ length: 100 }, (_, id) => ({ id, title: "a".repeat(800) })) }
    expect(await fixture({ chunks: [Buffer.from(JSON.stringify(value))] }).transport(input())).toEqual(value)
  })
  it("checks all budget arguments", async () => {
    for (const maxBytes of [0, -1, 1.1, NaN, HTTPS_RESPONSE_LIMIT + 1]) await expect(fixture().transport(input({ maxBytes }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    for (const timeoutMs of [0, -1, 1.1, 20_001]) await expect(fixture().transport(input({ timeoutMs }))).rejects.toMatchObject({ code: "INVALID_REQUEST" })
  })
})

describe("HTTPS cancellation and total deadline", () => {
  it("cancels before DNS without exposing AbortSignal.reason", async () => {
    const abort = new AbortController(); abort.abort(new Error(secret))
    const test = fixture()
    await expect(test.transport(input({ signal: abort.signal }))).rejects.toMatchObject({ code: "CANCELED", message: "Plugin HTTPS request failed: CANCELED" })
    expect(test.lookup).not.toHaveBeenCalled()
  })
  it("bounds a stalled DNS lookup and does not connect after its late completion", async () => {
    vi.useFakeTimers()
    const test = fixture()
    let finish!: (value: { address: string; family: number }[]) => void
    test.lookup.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const pending = test.transport(input({ timeoutMs: 10 }))
    const rejected = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" })
    await vi.advanceTimersByTimeAsync(10); await rejected
    finish([{ address: publicV4, family: 4 }]); await Promise.resolve()
    expect(test.request).not.toHaveBeenCalled()
  })
  it.each(["cancel", "deadline"])("destroys a stalled response on %s", async (mode) => {
    vi.useFakeTimers()
    const test = fixture({ hang: true, chunks: [] })
    const abort = new AbortController()
    const pending = test.transport(input({ signal: abort.signal, timeoutMs: 10 }))
    const rejected = expect(pending).rejects.toMatchObject({ code: mode === "cancel" ? "CANCELED" : "TIMEOUT" })
    await vi.advanceTimersByTimeAsync(0)
    if (mode === "cancel") abort.abort(new Error(secret))
    else await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(test.outgoing.destroy).toHaveBeenCalledOnce()
    expect(test.response.destroyed).toBe(true)
  })
  it("suppresses credential-bearing request constructor and socket errors", async () => {
    const test = fixture()
    test.request.mockImplementation(() => { throw new Error(secret) })
    await expect(test.transport(input())).rejects.toMatchObject({ code: "UPSTREAM_FAILED", message: "Plugin HTTPS request failed: UPSTREAM_FAILED" })
    const socket = fixture({ hang: true, chunks: [] })
    const pending = socket.transport(input())
    const rejected = expect(pending).rejects.toMatchObject({ code: "UPSTREAM_FAILED", message: "Plugin HTTPS request failed: UPSTREAM_FAILED" })
    await vi.waitFor(() => expect(socket.request).toHaveBeenCalledOnce())
    socket.outgoing.emit("error", new Error(secret))
    await rejected
    expect(socket.response.destroyed).toBe(true)
  })
})

describe("real TLS connection through the isolated test seam", { timeout: process.platform === "win32" ? 20_000 : 5_000 }, () => {
  it("uses a pinned lookup with original SNI and certificate verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cogpit-plugin-tls-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const key = join(directory, "key.pem"), cert = join(directory, "cert.pem"), config = join(directory, "openssl.cnf")
    await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=api.example.test\n[extensions]\nsubjectAltName=DNS:api.example.test\n")
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", key, "-out", cert], { timeout: 10_000 })
    const certificate = await readFile(cert)
    let observed: { authorization: string | undefined; url: string | undefined; servername: string | false | null } | undefined
    const server = createServer({ key: await readFile(key), cert: certificate }, (req, res) => {
      observed = { authorization: req.headers.authorization, url: req.url, servername: (req.socket as import("node:tls").TLSSocket).servername }
      res.setHeader("Content-Type", "application/json"); res.end('{"tls":true}')
    })
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) })
    server.listen(0, "127.0.0.1"); await once(server, "listening")
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing TLS port")
    let pinnedCalls = 0
    const localRequest = (options: RequestOptions, receive: (response: IncomingMessage) => void) => {
      const lookup: LookupFunction = (hostname, lookupOptions, callback) => options.lookup!(hostname, lookupOptions, (error, pinned, family) => {
        expect(error).toBeNull(); expect(pinned).toBe(publicV4); expect(family).toBe(4); pinnedCalls++
        callback(null, "127.0.0.1", 4)
      })
      return httpsRequest({ ...options, port: address.port, ca: certificate, lookup }, receive)
    }
    const transport = createPluginHttpsTransport({ lookup: async () => [{ address: publicV4, family: 4 }], request: localRequest })
    expect(await transport(input())).toEqual({ tls: true })
    expect(observed).toEqual({ authorization: `Bearer ${secret}`, url: "/v1/resources?limit=5", servername: "api.example.test" })
    expect(pinnedCalls).toBe(1)
    const denied = createPluginHttpsTransport({ lookup: async () => [{ address: "127.0.0.1", family: 4 }], request: localRequest })
    await expect(denied(input())).rejects.toMatchObject({ code: "NETWORK_DENIED" })
    expect(pinnedCalls).toBe(1)
    await expect(transport(input({ origin: "https://wrong.example.test" }))).rejects.toMatchObject({ code: "UPSTREAM_FAILED" })
  })
})
