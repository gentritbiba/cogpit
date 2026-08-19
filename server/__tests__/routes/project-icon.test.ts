// @vitest-environment node
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { registerProjectIconRoutes } from "../../routes/project-icon"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function getHandler(): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === "/api/project-icon") handler = candidate
  }
  registerProjectIconRoutes(use)
  if (!handler) throw new Error("Project icon route was not registered")
  return handler
}

describe("project icon route", () => {
  it("uses an empty successful response when a project has no icon", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-project-icon-route-"))
    temporaryDirectories.push(root)
    const req = new EventEmitter() as EventEmitter & { method: string; url: string }
    req.method = "GET"
    req.url = `/api/project-icon?cwd=${encodeURIComponent(root)}`
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
      headersSent: false,
    }

    await getHandler()(req as never, res as never, vi.fn())

    expect(res.statusCode).toBe(204)
    expect(res.end).toHaveBeenCalledWith()
  })
})
