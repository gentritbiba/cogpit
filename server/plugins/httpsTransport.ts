import { lookup as dnsLookup } from "node:dns/promises"
import type { LookupAddress } from "node:dns"
import type { ClientRequest, IncomingMessage } from "node:http"
import { request as httpsRequest, type RequestOptions } from "node:https"
import { isIP, type LookupFunction } from "node:net"
import ipaddr from "ipaddr.js"
import { parseJsonText } from "./json"

export const HTTPS_RESPONSE_LIMIT = 4 * 1024 * 1024
export const HTTPS_DEADLINE_MS = 20_000
export type HttpsTransportCode = "INVALID_REQUEST" | "NETWORK_DENIED" | "UPSTREAM_FAILED" | "INVALID_RESPONSE" | "CANCELED" | "TIMEOUT"
export class HttpsTransportError extends Error {
  constructor(readonly code: HttpsTransportCode) { super(`Plugin HTTPS request failed: ${code}`) }
}
export interface PluginHttpsInput {
  origin: string
  path: string
  credential: { header: string; scheme: "raw" | "bearer"; secret: string }
  signal: AbortSignal
  maxBytes?: number
  timeoutMs?: number
}
export interface HttpsTransportDependencies {
  lookup?: (hostname: string) => Promise<LookupAddress[]>
  request?: (options: RequestOptions, receive: (response: IncomingMessage) => void) => ClientRequest
}

const globalV6 = ipaddr.IPv6.parseCIDR("2000::/3")
const retired6bone = ipaddr.IPv6.parseCIDR("3ffe::/16")

export function isPublicAddress(address: string, family: number): boolean {
  if ((family !== 4 && family !== 6) || isIP(address) !== family || address.includes("%")) return false
  try {
    const parsed = ipaddr.parse(address)
    if (parsed.range() !== "unicast") return false
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6
      // RFC 5214 embeds IPv4 in ISATAP interface identifiers under arbitrary prefixes.
      if ((ipv6.parts[4] === 0 || ipv6.parts[4] === 0x0200) && ipv6.parts[5] === 0x5efe) return false
      return ipv6.match(globalV6) && !ipv6.match(retired6bone)
    }
    return true
  } catch { return false }
}

function validate(input: PluginHttpsInput): { hostname: string; headerValue: string; maxBytes: number; timeoutMs: number } {
  const invalid = () => { throw new HttpsTransportError("INVALID_REQUEST") }
  if (!input || Object.keys(input).some((key) => !["origin", "path", "credential", "signal", "maxBytes", "timeoutMs"].includes(key))) invalid()
  if (typeof input.origin !== "string" || input.origin.length > 256 || typeof input.path !== "string" || input.path.length > 8192 || !/^\/(?!\/)[\x21-\x7e]*$/.test(input.path) || /[#\\]/.test(input.path)) invalid()
  let url: URL
  try {
    url = new URL(input.origin)
    const target = new URL(input.path, url)
    if (url.protocol !== "https:" || url.origin !== input.origin || url.username || url.password || url.port
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(url.hostname)
      || /\.(?:localhost|local|internal)$/.test(url.hostname) || target.origin !== input.origin || target.pathname + target.search !== input.path) invalid()
    for (const segment of target.pathname.split("/")) {
      const decoded = decodeURIComponent(segment)
      if (decoded === "." || decoded === ".." || /[/%\\]/.test(decoded)
        || [...decoded].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid()
    }
  } catch { return invalid() as never }
  const credential = input.credential
  if (!credential || Object.keys(credential).some((key) => !["header", "scheme", "secret"].includes(key))
    || typeof credential.header !== "string" || credential.header.length > 64
    || credential.header.trim() !== credential.header
    || !/^(?:Authorization|X-[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*)$/i.test(credential.header)
    || /^x-(?:forwarded|http-method|original|rewrite)(?:-|$)/i.test(credential.header)
    || !["raw", "bearer"].includes(credential.scheme) || typeof credential.secret !== "string"
    || credential.secret.length > 4096 || credential.secret.trim() !== credential.secret || !/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(credential.secret)
    || !(input.signal instanceof AbortSignal)) invalid()
  const maxBytes = input.maxBytes ?? HTTPS_RESPONSE_LIMIT, timeoutMs = input.timeoutMs ?? HTTPS_DEADLINE_MS
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HTTPS_RESPONSE_LIMIT
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HTTPS_DEADLINE_MS) invalid()
  return { hostname: url!.hostname, headerValue: credential.scheme === "bearer" ? `Bearer ${credential.secret}` : credential.secret, maxBytes, timeoutMs }
}

function containsSecret(value: unknown, secret: string): boolean {
  if (value === null || typeof value !== "object") return String(value).includes(secret)
  return Object.entries(value).some(([key, entry]) => key.includes(secret) || containsSecret(entry, secret))
}

export function createPluginHttpsTransport(dependencies: HttpsTransportDependencies = {}) {
  const lookup = dependencies.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }))
  const request = dependencies.request ?? httpsRequest
  return async (input: PluginHttpsInput): Promise<unknown> => {
    let validated: ReturnType<typeof validate>
    try { validated = validate(input) } catch { throw new HttpsTransportError("INVALID_REQUEST") }
    const { hostname, headerValue, maxBytes, timeoutMs } = validated
    const { secret, header } = input.credential
    const { path, signal } = input
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      let settled = false
      let outgoing: ClientRequest | undefined
      let incoming: IncomingMessage | undefined
      let bytes: Buffer | undefined
      let size = 0
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", canceled); bytes = undefined }
      const fail = (code: HttpsTransportCode) => {
        if (settled) return
        settled = true
        cleanup()
        incoming?.destroy()
        outgoing?.destroy()
        reject(new HttpsTransportError(code))
      }
      const canceled = () => fail("CANCELED")
      const timer = setTimeout(() => fail("TIMEOUT"), timeoutMs)
      timer.unref?.()
      signal.addEventListener("abort", canceled, { once: true })
      if (signal.aborted) { canceled(); return }
      const receive = (response: IncomingMessage) => {
        incoming = response
        response.on("error", () => fail("UPSTREAM_FAILED"))
        response.once("aborted", () => fail("UPSTREAM_FAILED"))
        if (settled) { response.destroy(); return }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { fail("UPSTREAM_FAILED"); return }
        const seen = new Set<string>()
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index].toLowerCase()
          if (["content-type", "content-encoding", "content-length"].includes(name) && seen.has(name)) { fail("INVALID_RESPONSE"); return }
          seen.add(name)
        }
        const type = response.headers["content-type"], encoding = response.headers["content-encoding"], length = response.headers["content-length"]
        if (typeof type !== "string" || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)
          || (encoding !== undefined && encoding.toLowerCase() !== "identity")
          || (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes))) { fail("INVALID_RESPONSE"); return }
        bytes = Buffer.allocUnsafe(maxBytes)
        response.on("data", (chunk: Buffer) => {
          if (settled) return
          if (!Buffer.isBuffer(chunk) || size + chunk.length > maxBytes) { fail("INVALID_RESPONSE"); return }
          chunk.copy(bytes!, size)
          size += chunk.length
        })
        response.once("end", () => {
          if (settled) return
          if (signal.aborted) { canceled(); return }
          if (Date.now() >= deadline) { fail("TIMEOUT"); return }
          if (!response.complete || (length !== undefined && Number(length) !== size)) { fail("INVALID_RESPONSE"); return }
          let value: unknown
          try {
            value = parseJsonText(bytes!.subarray(0, size), maxBytes, { maxNodes: 100_000, maxDepth: 16 })
            if (containsSecret(value, secret)) throw new Error()
          } catch { fail("INVALID_RESPONSE"); return }
          if (Date.now() >= deadline) { fail("TIMEOUT"); return }
          settled = true
          cleanup()
          resolve(value)
        })
        response.once("close", () => { if (!response.complete) fail("UPSTREAM_FAILED") })
      }
      void Promise.resolve().then(() => lookup(hostname)).then((addresses) => {
        if (settled) return
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64
          || addresses.some((entry) => !entry || !isPublicAddress(entry.address, entry.family))) { fail("NETWORK_DENIED"); return }
        const address = { ...addresses[0] }
        const pinned: LookupFunction = (_host, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }])
          else callback(null, address.address, address.family)
        }
        const options: RequestOptions & { autoSelectFamily: boolean } = { protocol: "https:", hostname, port: 443, servername: hostname, method: "GET", path,
          agent: false, family: address.family, autoSelectFamily: false, lookup: pinned, rejectUnauthorized: true,
          maxHeaderSize: 16_384, headers: { Accept: "application/json", "Accept-Encoding": "identity", [header]: headerValue },
        }
        outgoing = request(options, receive)
        outgoing.on("error", () => fail("UPSTREAM_FAILED"))
        outgoing.once("upgrade", (_response, socket) => { socket.destroy(); fail("INVALID_RESPONSE") })
        outgoing.end()
      }).catch(() => fail("UPSTREAM_FAILED"))
    })
  }
}

export const pluginHttpsTransport = createPluginHttpsTransport()
