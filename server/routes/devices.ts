import type { IncomingMessage, ServerResponse } from "node:http"
import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"
import { getInstanceId } from "./hello"
import {
  getDevice,
  listDevices,
  addDevice,
  updateDevice,
  removeDevice,
  validateDeviceHost,
  setDeviceRuntime,
  type HubDevice,
} from "../hub/registry"
import {
  getDeviceToken,
  invalidateDeviceToken,
  DeviceAuthError,
  DeviceUnreachableError,
} from "../hub/device-client"

const DEFAULT_PORT = 19384
const DEFAULT_TLS_PORT = 443
const PROBE_TIMEOUT_MS = 3000

/** Base URL for a device, honoring its http/https scheme. */
function deviceOrigin(host: string, port: number, tls: boolean): string {
  return `${tls ? "https" : "http"}://${host}:${port}`
}

// ── Probe (device /api/hello handshake) ──────────────────────────────────

type ProbeCode = "UNREACHABLE" | "NOT_COGPIT" | "LEGACY_NO_HELLO" | "SELF_ADD"

interface HelloPayload {
  app: string
  version?: string
  hubApi?: number
  mode?: string
  name?: string
  instanceId?: string
  networkAccess?: boolean
  configured?: boolean
}

type ProbeResult =
  | { ok: true; hello: HelloPayload }
  | { ok: false; code: ProbeCode }

const PROBE_MESSAGES: Record<ProbeCode, string> = {
  UNREACHABLE: "Could not reach the device. Check the host, port, and that it is running.",
  NOT_COGPIT: "That address responded, but it is not a Cogpit device.",
  LEGACY_NO_HELLO: "That device runs an older Cogpit without hub support. Update it, then try again.",
  SELF_ADD: "That is this device — you cannot add the hub to itself.",
}

function isCogpitHello(value: unknown): value is HelloPayload {
  return !!value && typeof value === "object" && (value as { app?: unknown }).app === "cogpit"
}

/** GET the device's `/api/hello` and classify the response. */
async function probeDevice(host: string, port: number, tls: boolean, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(`${deviceOrigin(host, port, tls)}/api/hello`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
  } catch {
    return { ok: false, code: "UNREACHABLE" }
  } finally {
    clearTimeout(timer)
  }

  const contentType = res.headers.get("content-type") || ""

  // An older Cogpit has no /api/hello route; its SPA fallback answers with a
  // 200 text/html index instead. Treat that as an "update the device" signal
  // rather than a generic non-Cogpit server.
  if (res.status === 200 && contentType.includes("text/html")) {
    return { ok: false, code: "LEGACY_NO_HELLO" }
  }

  if (!contentType.includes("application/json")) {
    return { ok: false, code: "NOT_COGPIT" }
  }

  let hello: unknown
  try {
    hello = await res.json()
  } catch {
    return { ok: false, code: "NOT_COGPIT" }
  }

  if (!isCogpitHello(hello)) {
    return { ok: false, code: "NOT_COGPIT" }
  }
  if (hello.instanceId && hello.instanceId === getInstanceId()) {
    return { ok: false, code: "SELF_ADD" }
  }
  return { ok: true, hello }
}

// ── Password verification (device /api/auth/verify) ──────────────────────

type AuthCode = "BAD_PASSWORD" | "NETWORK_DISABLED" | "NOT_CONFIGURED" | "UNREACHABLE"

type AuthResult =
  | { ok: true; token?: string }
  | { ok: false; code: AuthCode }

const AUTH_MESSAGES: Record<AuthCode, string> = {
  BAD_PASSWORD: "The password was rejected by the device.",
  NETWORK_DISABLED: "Network access is disabled on that device. Enable it there first.",
  NOT_CONFIGURED: "That device has not finished setup yet.",
  UNREACHABLE: "Could not reach the device to verify the password.",
}

/** POST the password to the device's `/api/auth/verify` and classify the result. */
async function verifyDevicePassword(
  host: string,
  port: number,
  tls: boolean,
  password: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<AuthResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(`${deviceOrigin(host, port, tls)}/api/auth/verify`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${password}`,
        "content-type": "application/json",
      },
    })
  } catch {
    return { ok: false, code: "UNREACHABLE" }
  } finally {
    clearTimeout(timer)
  }

  if (res.status === 403) return { ok: false, code: "NETWORK_DISABLED" }
  if (res.status === 503) return { ok: false, code: "NOT_CONFIGURED" }
  if (!res.ok) return { ok: false, code: "BAD_PASSWORD" }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const valid = !!body && typeof body === "object" && (body as { valid?: unknown }).valid === true
  if (!valid) return { ok: false, code: "BAD_PASSWORD" }
  const rawToken = body && typeof body === "object" ? (body as { token?: unknown }).token : undefined
  return { ok: true, token: typeof rawToken === "string" ? rawToken : undefined }
}

// ── Small utilities ──────────────────────────────────────────────────────

function normalizePort(value: unknown, tls: boolean): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : tls ? DEFAULT_TLS_PORT : DEFAULT_PORT
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Strip the password before a device ever leaves the server. */
function toPublic(device: HubDevice): Omit<HubDevice, "password"> {
  const { password: _password, ...rest } = device
  return rest
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (chunk: Buffer) => { raw += chunk.toString() })
    req.on("end", () => {
      if (!raw.trim()) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null)
      } catch {
        resolve(null)
      }
    })
    req.on("error", () => resolve(null))
  })
}

// ── Handlers ─────────────────────────────────────────────────────────────

function handleList(res: ServerResponse): void {
  sendJson(res, 200, { devices: listDevices() })
}

async function handleProbe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const host = readString(body?.host)
  if (!body || !host) {
    return sendJson(res, 400, { error: "host is required", code: "BAD_REQUEST" })
  }
  // SSRF guard: the live probe fetches http://<host> just like handleAdd, so it
  // must reject loopback/link-local hosts unless this is an opt-in local tunnel.
  const hostError = validateDeviceHost(host, body.allowLocalTunnel === true)
  if (hostError) {
    return sendJson(res, 400, { error: hostError, code: "INVALID_HOST" })
  }
  const tls = body.tls === true
  const port = normalizePort(body.port, tls)
  const result = await probeDevice(host, port, tls)
  if (result.ok) {
    return sendJson(res, 200, { ok: true, hello: result.hello })
  }
  return sendJson(res, 200, { ok: false, code: result.code, error: PROBE_MESSAGES[result.code] })
}

async function handleAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  const host = readString(body?.host)
  if (!body || !host) {
    return sendJson(res, 400, { error: "host is required", code: "BAD_REQUEST" })
  }
  const tls = body.tls === true
  const port = normalizePort(body.port, tls)
  const allowLocalTunnel = body.allowLocalTunnel === true
  const password = readString(body.password)
  const name = readString(body.name)

  const hostError = validateDeviceHost(host, allowLocalTunnel)
  if (hostError) {
    return sendJson(res, 400, { error: hostError, code: "INVALID_HOST" })
  }

  const probe = await probeDevice(host, port, tls)
  if (!probe.ok) {
    return sendJson(res, probe.code === "UNREACHABLE" ? 502 : 400, {
      error: PROBE_MESSAGES[probe.code],
      code: probe.code,
    })
  }

  let auth: "password" | "none"
  if (password) {
    const verify = await verifyDevicePassword(host, port, tls, password)
    if (!verify.ok) {
      return sendJson(res, verify.code === "UNREACHABLE" ? 502 : 400, {
        error: AUTH_MESSAGES[verify.code],
        code: verify.code,
      })
    }
    auth = "password"
  } else {
    if (!allowLocalTunnel) {
      return sendJson(res, 400, {
        error: "A password is required unless this is a local tunnel.",
        code: "PASSWORD_REQUIRED",
      })
    }
    auth = "none"
  }

  const device = await addDevice({
    name: name || readString(probe.hello.name) || host,
    host,
    port,
    tls,
    auth,
    password,
  })
  setDeviceRuntime(device.id, { authState: "ok", lastProbe: Date.now(), lastHello: probe.hello })
  return sendJson(res, 201, { device: toPublic(device) })
}

async function handlePatch(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const device = getDevice(id)
  if (!device) {
    return sendJson(res, 404, { error: "Device not found", code: "UNKNOWN_DEVICE" })
  }
  const body = await readJsonBody(req)
  if (!body) {
    return sendJson(res, 400, { error: "Invalid JSON body", code: "BAD_REQUEST" })
  }

  const patch: Partial<HubDevice> = {}
  const newName = readString(body.name)
  if (newName) patch.name = newName

  const newHost = readString(body.host)
  const newTls = typeof body.tls === "boolean" ? body.tls : undefined
  const tls = newTls ?? device.tls === true
  const newPort = body.port !== undefined ? normalizePort(body.port, tls) : undefined
  const newPassword = readString(body.password)

  const host = newHost ?? device.host
  const port = newPort ?? device.port
  const hostChanged = !!newHost && newHost !== device.host
  const portChanged = newPort !== undefined && newPort !== device.port
  const tlsChanged = newTls !== undefined && newTls !== (device.tls === true)
  const sensitiveChanged = hostChanged || portChanged || tlsChanged || !!newPassword

  if (hostChanged) {
    const hostError = validateDeviceHost(newHost, device.auth === "none")
    if (hostError) {
      return sendJson(res, 400, { error: hostError, code: "INVALID_HOST" })
    }
    patch.host = newHost
  }
  if (portChanged) patch.port = newPort
  if (tlsChanged) patch.tls = newTls

  if (sensitiveChanged) {
    // Any credential-affecting change invalidates the cached device token so
    // the next request re-mints against the new host/password.
    invalidateDeviceToken(id)
    const probe = await probeDevice(host, port, tls)
    if (!probe.ok) {
      return sendJson(res, probe.code === "UNREACHABLE" ? 502 : 400, {
        error: PROBE_MESSAGES[probe.code],
        code: probe.code,
      })
    }
    if (newPassword) {
      const verify = await verifyDevicePassword(host, port, tls, newPassword)
      if (!verify.ok) {
        return sendJson(res, verify.code === "UNREACHABLE" ? 502 : 400, {
          error: AUTH_MESSAGES[verify.code],
          code: verify.code,
        })
      }
      patch.password = newPassword
      patch.auth = "password"
    }
    setDeviceRuntime(id, { authState: "ok", lastProbe: Date.now(), lastHello: probe.hello })
  }

  await updateDevice(id, patch)
  return sendJson(res, 200, { device: toPublic({ ...device, ...patch }) })
}

async function handleDelete(id: string, res: ServerResponse): Promise<void> {
  if (!getDevice(id)) {
    return sendJson(res, 404, { error: "Device not found", code: "UNKNOWN_DEVICE" })
  }
  await removeDevice(id)
  invalidateDeviceToken(id)
  return sendJson(res, 200, { success: true })
}

async function handleTest(id: string, res: ServerResponse): Promise<void> {
  const device = getDevice(id)
  if (!device) {
    return sendJson(res, 404, { error: "Device not found", code: "UNKNOWN_DEVICE" })
  }

  const probe = await probeDevice(device.host, device.port, device.tls === true)
  if (!probe.ok) {
    setDeviceRuntime(id, { authState: "unknown", lastProbe: Date.now() })
    return sendJson(res, 200, {
      ok: false,
      reachable: false,
      authState: "unknown",
      code: probe.code,
      error: PROBE_MESSAGES[probe.code],
    })
  }

  // No password to check for tunnel devices — reachability is the whole test.
  if (device.auth === "none") {
    setDeviceRuntime(id, { authState: "ok", lastProbe: Date.now(), lastHello: probe.hello })
    return sendJson(res, 200, { ok: true, reachable: true, authState: "ok", hello: probe.hello })
  }

  try {
    await getDeviceToken(device)
    setDeviceRuntime(id, { authState: "ok", lastProbe: Date.now(), lastHello: probe.hello })
    return sendJson(res, 200, { ok: true, reachable: true, authState: "ok", hello: probe.hello })
  } catch (err) {
    if (err instanceof DeviceAuthError) {
      setDeviceRuntime(id, { authState: "bad-password", lastProbe: Date.now(), lastHello: probe.hello })
      return sendJson(res, 200, {
        ok: false,
        reachable: true,
        authState: "bad-password",
        code: "BAD_PASSWORD",
        error: AUTH_MESSAGES.BAD_PASSWORD,
      })
    }
    if (err instanceof DeviceUnreachableError) {
      setDeviceRuntime(id, { authState: "unknown", lastProbe: Date.now() })
      return sendJson(res, 200, {
        ok: false,
        reachable: false,
        authState: "unknown",
        code: "UNREACHABLE",
        error: AUTH_MESSAGES.UNREACHABLE,
      })
    }
    setDeviceRuntime(id, { authState: "unknown", lastProbe: Date.now() })
    return sendJson(res, 502, { error: "Device test failed", code: "TEST_FAILED" })
  }
}

// ── Registration ─────────────────────────────────────────────────────────

/**
 * Hub device-management routes under `/api/hub/devices`. Mounted as a single
 * connect handler (like `/api/config`): the mount prefix is stripped, so
 * `req.url` here is the sub-path (`/`, `/probe`, `/:id`, `/:id/test`). Living
 * under `/api/hub/*` means the existing auth + NOT_CONFIGURED guards apply.
 */
export function registerDeviceRoutes(use: UseFn) {
  use("/api/hub/devices", (req, res, next) => {
    const method = req.method || "GET"

    // CSRF guard (same as the /hub proxy enforces): a state-changing request
    // must carry the X-Cogpit-Client header the SPA sends via hubFetch. A
    // drive-by cross-origin POST/PATCH/DELETE cannot set a custom header.
    if (method !== "GET" && method !== "HEAD" && !req.headers["x-cogpit-client"]) {
      return sendJson(res, 403, { error: "Missing X-Cogpit-Client header", code: "MISSING_CLIENT_HEADER" })
    }

    let sub = (req.url || "/").split("?")[0] || "/"
    if (sub !== "/" && sub.endsWith("/")) sub = sub.slice(0, -1)

    // Collection: /api/hub/devices
    if (sub === "/" || sub === "") {
      if (method === "GET") return handleList(res)
      if (method === "POST") return void handleAdd(req, res)
      return next()
    }

    // Probe: /api/hub/devices/probe
    if (sub === "/probe") {
      if (method === "POST") return void handleProbe(req, res)
      return next()
    }

    // Re-test: /api/hub/devices/:id/test
    const testMatch = sub.match(/^\/([^/]+)\/test$/)
    if (testMatch) {
      if (method === "POST") return void handleTest(testMatch[1], res)
      return next()
    }

    // Item: /api/hub/devices/:id
    const itemMatch = sub.match(/^\/([^/]+)$/)
    if (itemMatch) {
      if (method === "PATCH") return void handlePatch(itemMatch[1], req, res)
      if (method === "DELETE") return void handleDelete(itemMatch[1], res)
      return next()
    }

    return next()
  })
}
