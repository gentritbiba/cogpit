// @vitest-environment node
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../http"

const { mockDirs } = vi.hoisted(() => ({
  mockDirs: { SESSION_CONFIG_DIR: "" },
}))

vi.mock("../../helpers", async () => {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  return {
    dirs: mockDirs,
    join: path.join,
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    sendJson: (
      res: { statusCode: number; setHeader: (n: string, v: string) => void; end: (v?: string) => void },
      status: number,
      data: unknown,
    ) => {
      res.statusCode = status
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(data))
    },
  }
})

import { registerSessionConfigRoutes, isValidSessionConfigKey } from "../../routes/session-config"

interface FakeRes {
  statusCode: number
  headersSent: boolean
  writableEnded: boolean
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  json: () => unknown
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => {
      res.writableEnded = true
      return value
    }),
    json: () => JSON.parse((res.end.mock.calls[0]?.[0] as string) ?? "null"),
  }
  return res
}

function fakeReq(method: string, url: string, body?: string) {
  const req = new EventEmitter() as EventEmitter & {
    method: string
    url: string
    destroy: () => void
  }
  req.method = method
  req.url = url
  req.destroy = () => { /* noop */ }
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit("data", body)
      req.emit("end")
    })
  }
  return req
}

let handler: Middleware
let tempDir: string

async function invoke(method: string, url: string, body?: string): Promise<FakeRes> {
  const res = fakeRes()
  const next = vi.fn()
  await handler(
    fakeReq(method, url, body) as unknown as Parameters<Middleware>[0],
    res as unknown as Parameters<Middleware>[1],
    next,
  )
  // The handler resolves before the response is written for body-driven
  // requests; wait for end() to be called (or next() for pass-through).
  for (let i = 0; i < 50 && !res.writableEnded && !next.mock.calls.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return res
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "session-config-test-"))
  mockDirs.SESSION_CONFIG_DIR = join(tempDir, "session-config")
  const use: UseFn = (_path, middleware) => {
    handler = middleware
  }
  registerSessionConfigRoutes(use)
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe("session-config routes", () => {
  it("returns an empty object for a key with no stored config", async () => {
    const res = await invoke("GET", "/abc-123.jsonl")
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({})
  })

  it("stores config on PUT and returns it on GET", async () => {
    const put = await invoke("PUT", "/abc-123.jsonl", JSON.stringify({
      model: "claude-opus-4-7",
      permissionMode: "bypassPermissions",
    }))
    expect(put.statusCode).toBe(200)

    const get = await invoke("GET", "/abc-123.jsonl")
    expect(get.json()).toEqual({
      model: "claude-opus-4-7",
      permissionMode: "bypassPermissions",
    })
  })

  it("merges partial PUTs so independent writers keep their fields", async () => {
    await invoke("PUT", "/session.jsonl", JSON.stringify({ model: "opus", effort: "high" }))
    await invoke("PUT", "/session.jsonl", JSON.stringify({ mcpServers: ["clickup"] }))

    const res = await invoke("GET", "/session.jsonl")
    expect(res.json()).toEqual({
      model: "opus",
      effort: "high",
      mcpServers: ["clickup"],
    })
  })

  it("removes a field when the patch sets it to null", async () => {
    await invoke("PUT", "/session.jsonl", JSON.stringify({ model: "opus", effort: "high" }))
    await invoke("PUT", "/session.jsonl", JSON.stringify({ effort: null }))

    const res = await invoke("GET", "/session.jsonl")
    expect(res.json()).toEqual({ model: "opus" })
  })

  it("persists to a file named after the key", async () => {
    await invoke("PUT", "/my-session.jsonl", JSON.stringify({ fastMode: true }))
    const raw = await readFile(
      join(mockDirs.SESSION_CONFIG_DIR, "my-session.jsonl.json"),
      "utf-8",
    )
    expect(JSON.parse(raw)).toEqual({ fastMode: true })
  })

  it("rejects path-traversal and malformed keys", async () => {
    const res = await invoke("GET", "/..%2F..%2Fetc")
    expect(res.statusCode).toBe(400)

    expect(isValidSessionConfigKey("..")).toBe(false)
    expect(isValidSessionConfigKey(".hidden")).toBe(false)
    expect(isValidSessionConfigKey("a/b")).toBe(false)
    expect(isValidSessionConfigKey("")).toBe(false)
    expect(isValidSessionConfigKey("abc-123.jsonl")).toBe(true)
    expect(isValidSessionConfigKey("-Users-gentritbiba-agent-window")).toBe(true)
  })

  it("rejects non-object payloads", async () => {
    const res = await invoke("PUT", "/session.jsonl", JSON.stringify(["not", "an", "object"]))
    expect(res.statusCode).toBe(400)
  })

  it("rejects invalid JSON payloads", async () => {
    const res = await invoke("PUT", "/session.jsonl", "not-json")
    expect(res.statusCode).toBe(400)
  })
})
