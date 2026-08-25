import { describe, expect, it } from "vitest"
import { isSharedPath, sharePathFor, sharedSessionId } from "@/lib/sharePath"

describe("isSharedPath", () => {
  it("matches the guest route", () => {
    expect(isSharedPath("/shared/abc")).toBe(true)
  })

  it("tolerates a trailing slash", () => {
    expect(isSharedPath("/shared/abc/")).toBe(true)
    expect(sharedSessionId("/shared/abc/")).toBe("abc")
  })

  it("rejects extra segments so the route shape stays exactly /shared/:sessionId", () => {
    expect(isSharedPath("/shared/abc/extra")).toBe(false)
  })

  it("rejects a prefix that merely starts with the word", () => {
    expect(isSharedPath("/sharedxyz")).toBe(false)
    expect(isSharedPath("/shared-sessions/abc")).toBe(false)
  })

  it("rejects an empty session id", () => {
    expect(isSharedPath("/shared")).toBe(false)
    expect(isSharedPath("/shared/")).toBe(false)
  })

  it("rejects a device-prefixed path: shares do not compose with the hub", () => {
    expect(isSharedPath("/d/abc/shared/x")).toBe(false)
    expect(sharedSessionId("/d/abc/shared/x")).toBeNull()
  })

  it("is case-sensitive", () => {
    expect(isSharedPath("/Shared/abc")).toBe(false)
  })

  it("rejects a relative path", () => {
    expect(isSharedPath("shared/abc")).toBe(false)
  })
})

describe("sharedSessionId", () => {
  it("returns the id for a share path", () => {
    expect(sharedSessionId("/shared/8f3c-1d")).toBe("8f3c-1d")
  })

  it("percent-decodes the id exactly once, as the server does", () => {
    expect(sharedSessionId("/shared/a%20b")).toBe("a b")
  })

  it("returns null for an undecodable id rather than throwing", () => {
    expect(sharedSessionId("/shared/%E0%A4%A")).toBeNull()
    expect(isSharedPath("/shared/%E0%A4%A")).toBe(false)
  })

  it("returns null for a non-share path", () => {
    expect(sharedSessionId("/")).toBeNull()
  })
})

describe("sharePathFor", () => {
  it("builds the guest route", () => {
    expect(sharePathFor("8f3c-1d")).toBe("/shared/8f3c-1d")
  })

  it("round-trips every id sharedSessionId would accept", () => {
    for (const id of ["8f3c-1d", "a b", "a/b", "a%b", "?#", "\u00e9"]) {
      expect(sharedSessionId(sharePathFor(id))).toBe(id)
    }
  })

  it("encodes separators so a crafted id cannot escape the route", () => {
    expect(sharePathFor("../../api/projects")).toBe("/shared/..%2F..%2Fapi%2Fprojects")
    expect(isSharedPath(sharePathFor("../../api/projects"))).toBe(true)
  })
})
