// @vitest-environment node

import { PassThrough } from "node:stream"
import { Writable } from "node:stream"
import { once } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"

const { createReadStream, stat } = vi.hoisted(() => ({
  createReadStream: vi.fn(),
  stat: vi.fn(),
}))

vi.mock("node:fs", () => ({ createReadStream }))
vi.mock("node:fs/promises", () => ({ stat }))

import { registerLocalFileRoutes } from "../../routes/local-file"
import type { Middleware, UseFn } from "../../http"

class MemoryResponse extends Writable {
  statusCode = 200
  headersSent = false
  readonly headers = new Map<string, string>()
  readonly chunks: Buffer[] = []

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), String(value))
    return this
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.headersSent = true
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }

  get body(): string {
    return Buffer.concat(this.chunks).toString("utf8")
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

async function requestFile(stream: PassThrough): Promise<MemoryResponse> {
  let handler: Middleware | undefined
  const use: UseFn = (_path, registered) => { handler = registered }
  registerLocalFileRoutes(use)
  createReadStream.mockReturnValue(stream as never)
  stat.mockResolvedValue({ isFile: () => true, size: 5 })
  const response = new MemoryResponse()
  const finished = once(response, "finish")

  if (!handler) throw new Error("Local-file route was not registered")

  await handler(
    { method: "GET", url: "/?path=/tmp/image.png" } as never,
    response as never,
    () => undefined,
  )
  await finished
  return response
}

describe("local-file route", () => {
  it("streams a valid image", async () => {
    const stream = new PassThrough()
    stream.end("image")

    const response = await requestFile(stream)

    expect(response.statusCode).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.body).toBe("image")
  })

  it("handles a stat-to-open race without an unhandled stream error", async () => {
    const stream = new PassThrough()
    setImmediate(() => stream.emit("error", new Error("removed before open")))

    const response = await requestFile(stream)

    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body)).toEqual({ error: "File not found" })
  })
})
