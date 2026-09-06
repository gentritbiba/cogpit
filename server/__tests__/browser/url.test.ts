// @vitest-environment node
import { describe, expect, it } from "vitest"
import { resolveNavigationUrl } from "../../../shared/browser/url"

describe("resolveNavigationUrl", () => {
  it.each([
    ["example.com", "https://example.com"],
    ["  example.com/path?q=1  ", "https://example.com/path?q=1"],
    ["https://example.com", "https://example.com"],
    ["HTTP://EXAMPLE.COM", "HTTP://EXAMPLE.COM"],
    ["about:blank", "about:blank"],
    ["localhost", "http://localhost"],
    ["localhost:3000", "http://localhost:3000"],
    ["localhost:3000/app", "http://localhost:3000/app"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["0.0.0.0:4000", "http://0.0.0.0:4000"],
    ["[::1]:5173", "http://[::1]:5173"],
    ["127.0.0.1", "http://127.0.0.1"],
    ["localhost/app", "http://localhost/app"],
    ["example.com:8443", "https://example.com:8443"],
    ["example.com:8443/path", "https://example.com:8443/path"],
    ["localhosting.dev:8443", "https://localhosting.dev:8443"],
  ])("%s → %s", (input, expected) => {
    expect(resolveNavigationUrl(input)).toBe(expected)
  })

  it.each([
    "javascript:alert(1)",
    " JavaScript:void(0)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.com",
    "ftp://example.com/file",
    "",
    "   ",
  ])("rejects %j", (input) => {
    expect(() => resolveNavigationUrl(input)).toThrow()
  })
})
