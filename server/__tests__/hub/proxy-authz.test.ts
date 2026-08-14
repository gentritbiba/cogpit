// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import type { IncomingMessage } from "node:http"

import { hubProxyAuthorizationRejection, isForbiddenHubDownstreamPath } from "../../hub/proxy"
import { initEdition, __resetEditionForTest } from "../../team/edition"
import { setRequestPrincipal } from "../../team/requestPrincipal"
import type { SessionPrincipal } from "../../team/constants"

const ADMIN: SessionPrincipal = { userId: "admin", username: "alice", role: "admin" }
const MEMBER: SessionPrincipal = { userId: "member", username: "bob", role: "member" }

function request(principal?: SessionPrincipal): IncomingMessage {
  const req = {} as IncomingMessage
  if (principal) setRequestPrincipal(req, principal)
  return req
}

afterEach(() => __resetEditionForTest())

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
  ])("rejects normalized device authentication path %s", (path) => {
    expect(isForbiddenHubDownstreamPath(path)).toBe(true)
  })

  it.each(["/api/authentication", "/api/projects", "/api/authorize"])(
    "does not overmatch non-auth path %s",
    (path) => expect(isForbiddenHubDownstreamPath(path)).toBe(false),
  )
})

describe("hub downstream team authorization", () => {
  it("preserves personal-edition proxy behavior", () => {
    expect(hubProxyAuthorizationRejection(request(), "/api/config", "POST")).toBeNull()
  })

  it("fails closed when team middleware did not attach a principal", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    expect(hubProxyAuthorizationRejection(request(), "/api/projects", "GET")).toBe(401)
  })

  it("lets members proxy member-readable routes", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/projects", "GET")).toBeNull()
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/hub/devices", "GET")).toBeNull()
  })

  it("blocks members before an admin device credential is substituted", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/config", "POST")).toBe(403)
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/project-file", "PUT")).toBe(403)
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/hub/devices", "POST")).toBe(403)
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/projects/../config", "POST")).toBe(403)
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/projects/%2e%2e/config", "POST")).toBe(403)
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/projects%2f..%2fconfig", "POST")).toBe(403)
    expect(hubProxyAuthorizationRejection(request(MEMBER), "/api/projects%5c..%5cconfig", "POST")).toBe(403)
  })

  it("lets admins proxy admin routes", () => {
    initEdition({ shell: "standalone", configEdition: "team" })
    expect(hubProxyAuthorizationRejection(request(ADMIN), "/API/CONFIG", "post")).toBeNull()
  })
})
