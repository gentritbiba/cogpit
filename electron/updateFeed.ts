import { createHash } from "node:crypto"
import { createWriteStream, rmSync } from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream } from "node:stream/web"
import { load } from "js-yaml"
import { gt, valid } from "semver"

/** The release manifest electron-builder writes as latest-mac.yml / latest-linux.yml. */
export interface FeedFile { url: string; sha512: string; size: number }
export interface Feed { version: string; files: FeedFile[] }

export type Fetch = (url: string) => Promise<Response>

export const DEFAULT_FEED_URL = "https://github.com/gentritbiba/cogpit/releases/latest/download/"

export function parseFeed(text: string): Feed {
  const raw = load(text) as { version?: unknown; files?: unknown } | null
  const version = typeof raw?.version === "string" ? valid(raw.version) : null
  if (!version || !Array.isArray(raw?.files)) throw new Error("Update manifest is malformed.")
  const files = raw.files.flatMap((file: Partial<FeedFile>) =>
    typeof file?.url === "string" && /^[\w.-]+$/.test(file.url)
      && typeof file.sha512 === "string" && Number.isSafeInteger(file.size)
      ? [{ url: file.url, sha512: file.sha512, size: file.size as number }]
      : [])
  return { version, files }
}

export async function fetchFeed(fetchImpl: Fetch, feedUrl: string, name: string): Promise<Feed> {
  const res = await fetchImpl(new URL(name, feedUrl).href)
  if (!res.ok) throw new Error(`Update manifest request failed (${res.status}).`)
  return parseFeed(await res.text())
}

export function isNewer(remote: string, local: string): boolean {
  return valid(remote) !== null && valid(local) !== null && gt(remote, local)
}

/** electron-builder names the arm64 zip Cogpit-<v>-arm64-mac.zip and the x64 one Cogpit-<v>-mac.zip. */
export function pickMacArchive(feed: Feed, arch: string): FeedFile | null {
  const zips = feed.files.filter((file) => file.url.endsWith("-mac.zip"))
  return zips.find((file) => file.url.includes("-arm64-") === (arch === "arm64")) ?? null
}

export async function downloadVerified(fetchImpl: Fetch, url: string, file: FeedFile, destination: string): Promise<void> {
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) throw new Error(`Update download failed (${res.status}).`)
  const hash = createHash("sha512")
  let size = 0
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      size += chunk.length
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as ReadableStream), measure, createWriteStream(destination, { mode: 0o600 }))
    if (size !== file.size || hash.digest("base64") !== file.sha512) {
      throw new Error("Downloaded update does not match its manifest.")
    }
  } catch (error) {
    rmSync(destination, { force: true })
    throw error
  }
}
