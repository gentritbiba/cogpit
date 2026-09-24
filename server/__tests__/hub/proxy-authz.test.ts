// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import type { IncomingMessage } from "node:http"

import { __resetEditionForTest } from "../../edition"
import { hubProxyAuthorizationRejection, isForbiddenHubDownstreamPath } from "../../hub/proxy"
import { installFakeEdition } from "../edition/fakeEdition"

describe("hub downstream trust boundary", () => {
  it.each([
    "/api/auth",
    "/api/auth/verify",
    "/API/AUTH/LOGOUT",
    "/api/projects/../auth/logout",
    "/api/projects/%2e%2e/auth/verify",
    "/api/%61uth/logout",
    "/api/projects%2f..%2fauth%2flogout",
    "/api/projects%5c..%5cauth%5clogout",
    // Normalization resolves these back out of /api/auth, but the device's
    // router resolves nothing and still dispatches them to the auth mount.
    "/api/auth/logout/../..",
    "/api/auth/session/..",
    "/API/AUTH/verify/../../..",
  ])("rejects normalized device authentication path %s", (path) => {
    expect(isForbiddenHubDownstreamPath(path)).toBe(true)
  })

  it.each(["/api/authentication", "/api/projects", "/api/authorize"])(
    "does not overmatch non-auth path %s",
    (path) => expect(isForbiddenHubDownstreamPath(path)).toBe(false),
  )
})

describe("hub downstream authorization", () => {
  afterEach(() => __resetEditionForTest())

  it("preserves personal-edition proxy behavior", () => {
    expect(hubProxyAuthorizationRejection({} as IncomingMessage, "/api/config", "POST")).toBeNull()
  })

  it.each([
    ["/api/projects/../config", "/api/config"],
    ["/API/Projects/%2e%2e/Config?scope=all", "/api/config"],
    ["/api/projects%2f..%2fconfig", "/api/config"],
    ["/api/%E0%A4%A", null],
  ])("asks the edition about %s as the path the device will serve, %s", (downstreamPath, normalized) => {
    const hubProxyRejection = vi.fn(() => 403 as const)
    installFakeEdition({ hubProxyRejection })
    const req = {} as IncomingMessage

    expect(hubProxyAuthorizationRejection(req, downstreamPath, "POST")).toBe(403)
    expect(hubProxyRejection).toHaveBeenCalledExactlyOnceWith(req, normalized, "POST")
  })
})
