// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadVerified, fetchFeed, isNewer, parseFeed, pickMacArchive, type Fetch } from "../updateFeed.ts"

const MANIFEST = `version: 3.5.0
files:
  - url: Cogpit-3.5.0-arm64-mac.zip
    sha512: arm
    size: 10
  - url: Cogpit-3.5.0-arm64.dmg
    sha512: dmg
    size: 11
  - url: Cogpit-3.5.0-mac.zip
    sha512: intel
    size: 12
  - url: ../escape.zip
    sha512: bad
    size: 1
path: Cogpit-3.5.0-arm64-mac.zip
sha512: arm
releaseDate: '2026-10-27T10:00:00.000Z'
`

function respond(body: string | Buffer, status = 200): Fetch {
  return (async () => new Response(body, { status }))
}

describe("update feed", () => {
  it("reads an electron-builder manifest and drops files that are not plain names", () => {
    const feed = parseFeed(MANIFEST)
    expect(feed.version).toBe("3.5.0")
    expect(feed.files.map((file) => file.url)).toEqual(["Cogpit-3.5.0-arm64-mac.zip", "Cogpit-3.5.0-arm64.dmg", "Cogpit-3.5.0-mac.zip"])
  })

  it("rejects a manifest without a valid version", () => {
    expect(() => parseFeed("version: soon\nfiles: []")).toThrow("malformed")
    expect(() => parseFeed("<html>not yaml</html>")).toThrow("malformed")
  })

  it("resolves the manifest against the feed and reports HTTP failures", async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return new Response(MANIFEST)
    })
    await fetchFeed(fetchImpl, "https://example.test/releases/latest/download/", "latest-mac.yml")
    expect(urls).toEqual(["https://example.test/releases/latest/download/latest-mac.yml"])
    await expect(fetchFeed(respond("", 404), "https://example.test/", "latest-mac.yml")).rejects.toThrow("404")
  })

  it("picks the zip for the running architecture", () => {
    const feed = parseFeed(MANIFEST)
    expect(pickMacArchive(feed, "arm64")?.sha512).toBe("arm")
    expect(pickMacArchive(feed, "x64")?.sha512).toBe("intel")
    expect(pickMacArchive({ version: "3.5.0", files: [] }, "arm64")).toBeNull()
  })

  it("compares versions semantically", () => {
    expect(isNewer("3.10.0", "3.9.9")).toBe(true)
    expect(isNewer("3.4.1", "3.4.1")).toBe(false)
    expect(isNewer("3.4.0", "3.4.1")).toBe(false)
    expect(isNewer("garbage", "3.4.1")).toBe(false)
  })
})

describe("verified download", () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cogpit-update-feed-")) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const payload = Buffer.from("cogpit update payload")
  const file = { url: "x.zip", sha512: createHash("sha512").update(payload).digest("base64"), size: payload.length }

  it("writes a file that matches its manifest entry", async () => {
    const destination = join(root, "update.zip")
    await downloadVerified(respond(payload), "https://example.test/x.zip", file, destination)
    expect(readFileSync(destination)).toEqual(payload)
  })

  it("deletes a download whose hash or size does not match", async () => {
    const destination = join(root, "update.zip")
    await expect(downloadVerified(respond("tampered"), "https://example.test/x.zip", file, destination)).rejects.toThrow("does not match")
    expect(existsSync(destination)).toBe(false)
    await expect(downloadVerified(respond(payload), "https://example.test/x.zip", { ...file, size: 1 }, destination)).rejects.toThrow("does not match")
    expect(existsSync(destination)).toBe(false)
  })

  it("reports a failed request", async () => {
    await expect(downloadVerified(respond("", 503), "https://example.test/x.zip", file, join(root, "u.zip"))).rejects.toThrow("503")
  })
})
