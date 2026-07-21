// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest"

const { readFile, stat } = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}))

vi.mock("node:fs/promises", () => ({ readFile, stat }))

import type { Middleware, UseFn } from "../../http"
import { registerFileContentRoutes } from "../../routes/file-content"

function getHandler(): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (_path, registered) => { handler = registered }
  registerFileContentRoutes(use)
  if (!handler) throw new Error("File-content route was not registered")
  return handler
}

function createResponse() {
  const headers = new Map<string, string>()
  return {
    statusCode: 200,
    headers,
    setHeader: vi.fn((name: string, value: string | number | readonly string[]) => {
      headers.set(name.toLowerCase(), String(value))
    }),
    end: vi.fn(),
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("file-content route", () => {
  it("returns validated text content with non-cacheable response headers", async () => {
    stat.mockResolvedValue({ isFile: () => true, size: 5 })
    readFile.mockResolvedValue("hello")
    const response = createResponse()

    await getHandler()(
      { method: "GET", url: "/?path=%2Ftmp%2Fnotes.txt" } as never,
      response as never,
      vi.fn(),
    )

    expect(readFile).toHaveBeenCalledWith("/tmp/notes.txt", "utf-8")
    expect(response.statusCode).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(response.end).toHaveBeenCalledWith("hello")
  })

  it("maps a read-after-stat race to a stable server error", async () => {
    stat.mockResolvedValue({ isFile: () => true, size: 5 })
    readFile.mockRejectedValue(new Error("removed before read"))
    const response = createResponse()

    await getHandler()(
      { method: "GET", url: "/?path=%2Ftmp%2Fnotes.txt" } as never,
      response as never,
      vi.fn(),
    )

    expect(response.statusCode).toBe(500)
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "Failed to read file" }))
  })
})
