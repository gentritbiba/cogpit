// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { IncomingMessage } from "node:http"
import { getRequestPrincipal, setRequestPrincipal } from "../requestPrincipal"
import type { SessionPrincipal } from "../sessionConstants"

describe("requestPrincipal", () => {
  it("stores and returns a principal per request object", () => {
    const req = {} as IncomingMessage
    const principal: SessionPrincipal = { userId: "u_1", username: "alice", role: "admin" }

    setRequestPrincipal(req, principal)
    expect(getRequestPrincipal(req)).toEqual(principal)
  })

  it("returns null for a request it has never seen", () => {
    expect(getRequestPrincipal({} as IncomingMessage)).toBeNull()
  })
})
