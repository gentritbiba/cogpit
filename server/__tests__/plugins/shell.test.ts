// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { PLUGIN_SHELL_HEADERS, PLUGIN_SHELL_HTML, PLUGIN_SHELL_PATH } from "../../plugins/shell"

describe("runtime shell response", () => {
  it("binds the exact bootstrap bytes to CSP and keeps direct navigation sandboxed", () => {
    const script = PLUGIN_SHELL_HTML.match(/<script>([\s\S]+)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    const hash = createHash("sha256").update(script!).digest("base64")
    expect(PLUGIN_SHELL_HEADERS["Content-Security-Policy"]).toContain(`script-src 'sha256-${hash}' blob:`)
    expect(PLUGIN_SHELL_HEADERS["Content-Security-Policy"]).toContain("sandbox allow-scripts")
    expect(PLUGIN_SHELL_HEADERS["Content-Security-Policy"]).not.toContain("allow-same-origin")
    expect(() => new Function(script!)).not.toThrow()
  })
  it("allows only same-origin framing and blocks direct network and nested frames", () => {
    const csp = PLUGIN_SHELL_HEADERS["Content-Security-Policy"]
    for (const directive of ["frame-ancestors 'self'", "connect-src 'none'", "worker-src 'none'", "font-src 'none'", "frame-src 'none'", "form-action 'none'"]) expect(csp).toContain(directive)
    expect(PLUGIN_SHELL_HEADERS["X-Frame-Options"]).toBe("SAMEORIGIN")
    expect(PLUGIN_SHELL_HEADERS["Cache-Control"]).toBe("no-store")
    expect(PLUGIN_SHELL_PATH).toBe("/api/plugins/shell/v1")
  })
})
