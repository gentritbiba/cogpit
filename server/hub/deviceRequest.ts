import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http"
import { request as httpsRequest } from "node:https"
import { getDevice, type HubDevice } from "./registry"
import {
  DeviceAuthError,
  DeviceUnreachableError,
  getDeviceTokenLease,
  invalidateDeviceTokenGeneration,
  type DeviceTokenLease,
} from "./device-client"

/**
 * Server-side requests from the hub to a registered device's API, for hub
 * features that talk to a device themselves rather than relaying a browser
 * request (the proxy) — the plugin relay and remote session control.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_ERROR_BODY_BYTES = 64 * 1024

export interface DeviceHttpRequest {
  device: HubDevice
  token: DeviceTokenLease | null
  method: string
  path: string
  headers?: Record<string, string>
  body?: Buffer
  signal?: AbortSignal
  /** Whole-request budget, including the response body. */
  timeoutMs?: number
  maxResponseBytes?: number
}

export interface DeviceHttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function openRequest(input: DeviceHttpRequest, onResponse: (response: IncomingMessage) => void, onError: (error: Error) => void) {
  const body = input.body ?? Buffer.alloc(0)
  const request = (input.device.tls ? httpsRequest : httpRequest)({
    hostname: input.device.host,
    port: input.device.port,
    method: input.method,
    path: input.path,
    signal: input.signal,
    headers: {
      ...input.headers,
      "X-Cogpit-Client": "1",
      "Content-Length": String(body.length),
      ...(input.device.auth === "password" && input.token?.token ? { Authorization: `Bearer ${input.token.token}` } : {}),
    },
  })
  const timeout = setTimeout(
    () => request.destroy(new Error(`Request to device "${input.device.name}" timed out`)),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  timeout.unref?.()
  request.once("close", () => clearTimeout(timeout))
  request.once("error", onError)
  request.once("response", onResponse)
  request.end(body)
}

/** One raw request with a fully buffered response. */
export function sendDeviceRequest(input: DeviceHttpRequest): Promise<DeviceHttpResponse> {
  const limit = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  return new Promise((resolve, reject) => {
    openRequest(input, (response) => {
      const chunks: Buffer[] = []
      let length = 0
      response.on("data", (chunk: Buffer) => {
        length += chunk.length
        if (length > limit) {
          response.destroy(new Error(`Response from device "${input.device.name}" exceeds its limit`))
          return
        }
        chunks.push(chunk)
      })
      response.once("error", reject)
      response.once("aborted", () => reject(new Error(`Response from device "${input.device.name}" was aborted`)))
      response.once("end", () => resolve({
        status: response.statusCode ?? 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    }, reject)
  })
}

// ── Authenticated calls by device id ────────────────────────────────────────

/** The device answered, but not with success. */
export class DeviceRequestError extends Error {
  constructor(
    readonly deviceId: string,
    readonly status: number,
    message: string,
    readonly code?: string,
    /** The device's parsed JSON answer, when it sent one. */
    readonly body?: unknown,
  ) {
    super(message)
    this.name = "DeviceRequestError"
  }
}

export interface DeviceCall {
  method: string
  path: string
  body?: Buffer
  contentType?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxResponseBytes?: number
}

function registeredDevice(deviceId: string): HubDevice {
  const device = getDevice(deviceId)
  if (!device) throw new DeviceRequestError(deviceId, 404, `Unknown device "${deviceId}"`, "UNKNOWN_DEVICE")
  return device
}

/**
 * Run one call against a device with its hub token, re-minting once when the
 * device rejects a token that expired or was rotated. `attempt` owns the
 * request so streaming and buffered callers share the retry.
 */
async function withDeviceToken<T extends { status: number }>(
  deviceId: string,
  attempt: (device: HubDevice, token: DeviceTokenLease) => Promise<T>,
): Promise<T> {
  const device = { ...registeredDevice(deviceId) }
  const call = async (token: DeviceTokenLease) => {
    try {
      return await attempt(device, token)
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw error
      throw new DeviceUnreachableError(
        deviceId,
        `Could not reach device "${device.name}" at ${device.host}:${device.port}`,
        { cause: error },
      )
    }
  }
  let token = await getDeviceTokenLease(device)
  let response = await call(token)
  if (response.status === 401 && device.auth === "password") {
    invalidateDeviceTokenGeneration(deviceId, token.generation)
    token = await getDeviceTokenLease(device)
    response = await call(token)
  }
  if (response.status === 401) throw new DeviceAuthError(deviceId, `Device "${device.name}" rejected the hub's credentials`, 401)
  return response
}

function failure(deviceId: string, status: number, raw: Buffer): DeviceRequestError {
  let body: unknown
  try {
    body = JSON.parse(raw.toString("utf8"))
  } catch {
    body = undefined
  }
  const { error, code } = (body ?? {}) as { error?: unknown; code?: unknown }
  return new DeviceRequestError(
    deviceId,
    status,
    typeof error === "string" ? error : `Device answered HTTP ${status}`,
    typeof code === "string" ? code : undefined,
    body,
  )
}

/** A buffered call; non-2xx answers throw `DeviceRequestError` with the device's own message. */
export async function callDevice(deviceId: string, call: DeviceCall): Promise<DeviceHttpResponse> {
  const response = await withDeviceToken(deviceId, (device, token) => sendDeviceRequest({
    device,
    token,
    method: call.method,
    path: call.path,
    headers: { ...call.headers, ...(call.contentType ? { "Content-Type": call.contentType } : {}) },
    body: call.body,
    signal: call.signal,
    timeoutMs: call.timeoutMs,
    maxResponseBytes: call.maxResponseBytes,
  }))
  if (response.status >= 200 && response.status < 300) return response
  throw failure(deviceId, response.status, response.body)
}

export async function deviceJson<T>(
  deviceId: string,
  method: string,
  path: string,
  body?: unknown,
  options: Pick<DeviceCall, "signal" | "timeoutMs" | "headers"> = {},
): Promise<T> {
  const response = await callDevice(deviceId, {
    method,
    path,
    ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)), contentType: "application/json" }),
    ...options,
  })
  return JSON.parse(response.body.toString("utf8")) as T
}

/**
 * A streamed GET for payloads too large to buffer. The caller consumes (or
 * destroys) the returned response; it is already known to be 2xx.
 */
export async function openDeviceStream(
  deviceId: string,
  path: string,
  options: Pick<DeviceCall, "signal" | "timeoutMs" | "headers"> = {},
): Promise<IncomingMessage> {
  const { status, response } = await withDeviceToken(deviceId, (device, token) => new Promise<{
    status: number
    response: IncomingMessage
  }>((resolve, reject) => {
    openRequest(
      { device, token, method: "GET", path, headers: options.headers, signal: options.signal, timeoutMs: options.timeoutMs },
      (response) => {
        // A rejected token gets a retry; drain the refusal so its socket frees.
        if (response.statusCode === 401) response.resume()
        resolve({ status: response.statusCode ?? 502, response })
      },
      reject,
    )
  }))
  if (status >= 200 && status < 300) return response
  // An error answer is a short JSON message; read no more than that of it.
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of response) {
    chunks.push(chunk as Buffer)
    length += (chunk as Buffer).length
    if (length > MAX_ERROR_BODY_BYTES) {
      response.destroy()
      break
    }
  }
  throw failure(deviceId, status, Buffer.concat(chunks))
}
