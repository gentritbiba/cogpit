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

interface RequestOptions {
  path?: string
  size?: number
  range?: string
}

async function requestFile(
  stream: PassThrough,
  { path = "/tmp/image.png", size = 5, range }: RequestOptions = {},
): Promise<MemoryResponse> {
  let handler: Middleware | undefined
  const use: UseFn = (_path, registered) => { handler = registered }
  registerLocalFileRoutes(use)
  createReadStream.mockReturnValue(stream as never)
  stat.mockResolvedValue({ isFile: () => true, size })
  const response = new MemoryResponse()
  const finished = once(response, "finish")

  if (!handler) throw new Error("Local-file route was not registered")

  await handler(
    {
      method: "GET",
      url: `/?path=${encodeURIComponent(path)}`,
      headers: range ? { range } : {},
    } as never,
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
    expect(response.headers.get("content-length")).toBe("5")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.body).toBe("image")
  })

  it("streams a video with its media type", async () => {
    const stream = new PassThrough()
    stream.end("video")

    const response = await requestFile(stream, { path: "/tmp/recording.mp4" })

    expect(response.statusCode).toBe(200)
    expect(response.headers.get("content-type")).toBe("video/mp4")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.body).toBe("video")
  })

  it("serves a byte range so the video element can seek", async () => {
    const stream = new PassThrough()
    stream.end("de")

    const response = await requestFile(stream, {
      path: "/tmp/recording.webm",
      size: 5,
      range: "bytes=2-3",
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 2-3/5")
    expect(response.headers.get("content-length")).toBe("2")
    expect(createReadStream).toHaveBeenCalledWith("/tmp/recording.webm", { start: 2, end: 3 })
    expect(response.body).toBe("de")
  })

  it("clamps an open-ended range to the end of the file", async () => {
    const stream = new PassThrough()
    stream.end("deo")

    const response = await requestFile(stream, {
      path: "/tmp/recording.mov",
      size: 5,
      range: "bytes=2-",
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 2-4/5")
    expect(createReadStream).toHaveBeenCalledWith("/tmp/recording.mov", { start: 2, end: 4 })
  })

  it("serves a suffix range from the end of the file", async () => {
    const stream = new PassThrough()
    stream.end("de")

    const response = await requestFile(stream, {
      path: "/tmp/recording.mp4",
      size: 5,
      range: "bytes=-2",
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 3-4/5")
    expect(createReadStream).toHaveBeenCalledWith("/tmp/recording.mp4", { start: 3, end: 4 })
  })

  it("rejects a range that starts past the end of the file", async () => {
    const response = await requestFile(new PassThrough(), {
      path: "/tmp/recording.mp4",
      size: 5,
      range: "bytes=9-12",
    })

    expect(response.statusCode).toBe(416)
    expect(response.headers.get("content-range")).toBe("bytes */5")
    expect(createReadStream).not.toHaveBeenCalled()
  })

  it("allows videos larger than the image ceiling", async () => {
    const stream = new PassThrough()
    stream.end("video")

    const response = await requestFile(stream, {
      path: "/tmp/recording.mp4",
      size: 200 * 1024 * 1024,
    })

    expect(response.statusCode).toBe(200)
  })

  it("refuses files that are neither images nor videos", async () => {
    const response = await requestFile(new PassThrough(), { path: "/etc/passwd" })

    expect(response.statusCode).toBe(403)
    expect(createReadStream).not.toHaveBeenCalled()
  })

  it("handles a stat-to-open race without an unhandled stream error", async () => {
    const stream = new PassThrough()
    setImmediate(() => stream.emit("error", new Error("removed before open")))

    const response = await requestFile(stream)

    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body)).toEqual({ error: "File not found" })
  })
})
