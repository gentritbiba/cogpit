// @vitest-environment node
import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SESSION_ACCESS_HEADER, type SessionAccessLevel } from "../../../shared/contracts/sessionAccess"
import { createMockReqRes } from "../http-fixtures"
import {
  __resetEditionForTest,
  mayActHostWide,
  authorizeHostWide,
  itemVisibilityFor,
  PERSONAL_EDITION,
  type VisibleSession,
} from "../../edition"
import { setRequestPrincipal } from "../../requestPrincipal"
import type { SessionPrincipal } from "../../sessionConstants"
import { markShareGuestRequest } from "../../share/requestGuest"
import { installFakeEdition, useAccountSignIn } from "./fakeEdition"

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e"
const OTHER = "1f8fad5b-d9cb-469f-a165-70867728950e"
const ADMIN: SessionPrincipal = { userId: "u_admin", username: "ada", role: "admin" }
const MEMBER: SessionPrincipal = { userId: "u_bob", username: "bob", role: "member" }

function request(principal?: SessionPrincipal): IncomingMessage {
  const req = { headers: {} } as IncomingMessage
  if (principal) setRequestPrincipal(req, principal)
  return req
}

afterEach(() => __resetEditionForTest())

describe("mayActHostWide", () => {
  it("is the one trusted owner in personal edition", () => {
    expect(mayActHostWide(request())).toBe(true)
  })

  it("is whom the edition says administers, and nobody else, where it signs accounts in", () => {
    const auth = useAccountSignIn()
    expect(mayActHostWide(request(ADMIN))).toBe(true)
    expect(auth.administers).toHaveBeenCalledWith(ADMIN)
    expect(mayActHostWide(request(MEMBER))).toBe(false)
    const guest = request()
    markShareGuestRequest(guest, SESSION)
    expect(mayActHostWide(guest)).toBe(false)
    expect(mayActHostWide(request())).toBe(false)
  })
})

describe("itemVisibilityFor", () => {
  it("shows everything in personal edition", async () => {
    const visible = itemVisibilityFor(request())
    await expect(visible(null)).resolves.toBe(true)
    await expect(visible(SESSION)).resolves.toBe(true)
  })

  it("shows host-wide items only to whom the edition says administers, and session items as the session allows", async () => {
    // Only sign-in is faked; personal session hooks make every session visible here.
    useAccountSignIn()
    await expect(itemVisibilityFor(request(ADMIN))(null)).resolves.toBe(true)
    const member = itemVisibilityFor(request(MEMBER))
    await expect(member(null)).resolves.toBe(false)
    await expect(member(SESSION)).resolves.toBe(true)
  })

  it("shows a session item needing more than view only to a caller holding that much", async () => {
    const levels: Record<string, SessionAccessLevel> = { [SESSION]: "view", [OTHER]: "interact" }
    const check = async (sessionId: string): Promise<VisibleSession> => ({
      annotate: async (item) => ({ ...item, access: { level: levels[sessionId], owner: null, mine: false, sharedWithMe: true, inheritsFrom: null } }),
    })
    installFakeEdition({
      access: { ...PERSONAL_EDITION.access, visibilityFor: () => Object.assign(check, { everything: false, nothing: false }) },
    })
    const visible = itemVisibilityFor(request(MEMBER))
    await expect(visible(SESSION)).resolves.toBe(true)
    await expect(visible(SESSION, "interact")).resolves.toBe(false)
    await expect(visible(OTHER, "interact")).resolves.toBe(true)
    await expect(visible(OTHER, "own")).resolves.toBe(false)
  })

  it("holds personal edition's one caller to own every session", async () => {
    await expect(itemVisibilityFor(request())(SESSION, "own")).resolves.toBe(true)
  })

  it("checks each session once however many items name it", async () => {
    const check = vi.fn(async (): Promise<VisibleSession> => ({ annotate: async (item) => item }))
    installFakeEdition({
      access: { ...PERSONAL_EDITION.access, visibilityFor: () => Object.assign(check, { everything: false, nothing: false }) },
    })
    const visible = itemVisibilityFor(request(MEMBER))
    await expect(Promise.all([visible(SESSION), visible(SESSION), visible(SESSION)])).resolves.toEqual([true, true, true])
    expect(check).toHaveBeenCalledTimes(1)
  })
})

describe("authorizeHostWide", () => {
  function authorize(principal?: SessionPrincipal) {
    const call = createMockReqRes("GET", "/")
    if (principal) setRequestPrincipal(call.req, principal)
    return { allowed: authorizeHostWide(call.req, call.res), call }
  }

  it("lets the one trusted owner through in personal edition without answering", () => {
    const { allowed, call } = authorize()
    expect(allowed).toBe(true)
    expect(call.res.end).not.toHaveBeenCalled()
  })

  it("lets an administrator through and hides the item from anyone else as a session they cannot see", () => {
    useAccountSignIn()
    expect(authorize(ADMIN).allowed).toBe(true)

    const { allowed, call } = authorize(MEMBER)
    expect(allowed).toBe(false)
    expect(call.res.statusCode).toBe(404)
    expect(call.res.setHeader).toHaveBeenCalledWith(SESSION_ACCESS_HEADER, "none")
    expect(JSON.parse(call.res._getData())).toEqual({ error: "Session not found", code: "NOT_FOUND" })
  })
})
