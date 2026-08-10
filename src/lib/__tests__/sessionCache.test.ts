import { describe, it, expect, beforeEach } from "vitest"
import type { ParsedSession } from "@/lib/types"
import { sessionCache } from "@/lib/sessionCache"
import {
  __resetDeviceRevisionsForTest,
  __resetIdentityForTest,
  recordDeviceConnectionRevision,
  setActiveIdentity,
} from "@/lib/device"

function setPath(pathname: string) {
  Object.defineProperty(window, "location", {
    value: { pathname },
    writable: true,
    configurable: true,
  })
}

const parsed = { turns: [] } as unknown as ParsedSession

function seed(dirName: string, fileName: string) {
  sessionCache.set(dirName, fileName, parsed, "raw", 0, false)
}

describe("sessionCache device scoping", () => {
  beforeEach(() => {
    sessionCache.clear()
    __resetDeviceRevisionsForTest()
    __resetIdentityForTest()
    setPath("/")
  })

  it("keys entries by the active device so different devices never collide", () => {
    // Local device stores an entry for a dirName.
    setPath("/")
    seed("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()

    // The same (dirName, fileName) on a remote device is a cache MISS.
    setPath("/d/dev_x/")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()
  })

  it("keeps each device's entry warm across a switch-back", () => {
    setPath("/")
    seed("-Users-foo", "sess.jsonl")

    setPath("/d/dev_x/")
    seed("-Users-foo", "sess.jsonl") // remote entry under the scoped key
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()

    // Switch back to local — the original local entry is still cached.
    setPath("/")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()
  })

  it("evicts under the device-scoped key", () => {
    setPath("/d/dev_x/")
    seed("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()

    sessionCache.evict("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()

    // The local scope was never populated, so it stays empty too.
    setPath("/")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()
  })

  it("keeps cached transcripts isolated between signed-in users", () => {
    setActiveIdentity("u_1")
    seed("-Users-foo", "sess.jsonl")

    setActiveIdentity("u_2")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()

    setActiveIdentity("u_1")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()
  })

  it("isolates the same device id across sensitive connection revisions", () => {
    setPath("/d/dev_x/")
    recordDeviceConnectionRevision("dev_x", 4)
    seed("-Users-foo", "sess.jsonl")

    recordDeviceConnectionRevision("dev_x", 5)
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeUndefined()

    // A duplicate/name-only registry notification keeps the same scope.
    recordDeviceConnectionRevision("dev_x", 5)
    seed("-Users-foo", "sess.jsonl")
    expect(sessionCache.get("-Users-foo", "sess.jsonl")).toBeDefined()
  })
})
