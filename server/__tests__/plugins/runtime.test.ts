// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { registerPluginRoutes } from "../../routes/plugins"
import { pluginRuntimeDescriptor } from "../../plugins/runtime"
import { requirementFor } from "../../team/policy"
import type { Middleware } from "../../http"

describe("selected-host runtime descriptor", () => {
  it("reports this process's version and registry revision without account data", () => {
    const descriptor = pluginRuntimeDescriptor(42)
    expect(descriptor.registryRevision).toBe(42)
    expect(descriptor.appVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(descriptor.protocolVersions).toEqual([1])
    expect(descriptor).not.toHaveProperty("connections")
    expect(requirementFor("/api/plugins/runtime", "GET")).toBe("admin")
    expect(requirementFor("/api/plugins/packages/abc", "GET")).toBe("admin")
  })

  it("terminates unknown package routes instead of falling through to HTML", () => {
    let handler: Middleware | undefined
    registerPluginRoutes((_path, value) => { handler = value })
    const response = { setHeader: vi.fn(), end: vi.fn(), statusCode: 0 }
    const next = vi.fn()
    handler!({ url: "/packages/missing.js", method: "GET" } as never, response as never, next)
    expect(response.statusCode).toBe(404)
    expect(next).not.toHaveBeenCalled()
    expect(JSON.parse(response.end.mock.calls[0][0])).toMatchObject({ code: "NOT_FOUND" })
  })
})
