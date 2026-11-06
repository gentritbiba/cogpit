// @vitest-environment node
import type { IncomingMessage, ServerResponse } from "node:http"
import { describe, expect, it, vi } from "vitest"
import { VIEW_SHELL_PATH } from "../../../shared/views/shell"
import type { Middleware } from "../../http"
import { registerViewRoutes } from "../../routes/views"
import { VIEW_SHELL_HEADERS, VIEW_SHELL_HTML } from "../../views/shell"

describe("interactive view shell", () => {
  it("runs views without an origin, network or nested frames", () => {
    const csp = VIEW_SHELL_HEADERS["Content-Security-Policy"]
    expect(csp).toContain("sandbox allow-scripts")
    expect(csp).not.toContain("allow-same-origin")
    for (const directive of ["default-src 'none'", "frame-ancestors 'self'", "form-action 'none'", "connect-src blob: data:", "frame-src 'none'", "img-src data: blob:"]) {
      expect(csp).toContain(directive)
    }
    // Only framing names an origin; no source list reaches the app or the web.
    expect(csp.replace("frame-ancestors 'self'", "")).not.toMatch(/https?:|'self'|\*/)
    expect(VIEW_SHELL_HEADERS["X-Frame-Options"]).toBe("SAMEORIGIN")
  })

  it("ships a bridge that parses", () => {
    const script = VIEW_SHELL_HTML.match(/<script>([\s\S]+)<\/script>/)?.[1]
    expect(() => new Function(script!)).not.toThrow()
  })

  it("is served at the shared path and leaves everything else to later routes", () => {
    let mount = ""
    let handler: Middleware | null = null
    registerViewRoutes((path, route) => { mount = path; handler = route })
    const res = { setHeader: vi.fn(), end: vi.fn() }
    const next = vi.fn()
    const call = (method: string, url: string) => handler!({ method, url } as IncomingMessage, res as unknown as ServerResponse, next)

    call("GET", VIEW_SHELL_PATH.slice(mount.length))
    expect(res.end).toHaveBeenCalledWith(VIEW_SHELL_HTML)
    expect(res.setHeader).toHaveBeenCalledWith("Content-Security-Policy", VIEW_SHELL_HEADERS["Content-Security-Policy"])
    expect(next).not.toHaveBeenCalled()

    call("POST", "/shell/v1")
    call("GET", "/shell/v2")
    call("GET", "/Bad-Id/v/1")
    call("GET", "/sales-funnel/v/0")
    expect(next).toHaveBeenCalledTimes(4)
    expect(res.end).toHaveBeenCalledTimes(1)
  })
})
