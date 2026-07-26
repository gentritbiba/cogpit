// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPushConfig, resetPushConfigCache } from "../../lib/pushConfig"

let dir: string
let file: string
const ENV_KEYS = ["COGPIT_NTFY_TOPIC", "COGPIT_NTFY_URL", "COGPIT_NTFY_TOKEN", "COGPIT_PUBLIC_URL"] as const

function write(contents: unknown): void {
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cogpit-push-"))
  file = join(dir, "push.json")
  for (const key of ENV_KEYS) delete process.env[key]
  resetPushConfigCache()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const key of ENV_KEYS) delete process.env[key]
  vi.restoreAllMocks()
})

describe("getPushConfig — unconfigured", () => {
  it("returns null when the file is absent", () => {
    expect(getPushConfig(file)).toBeNull()
  })

  it("returns null when the topic is missing, empty, or whitespace", () => {
    write({ ntfyUrl: "https://ntfy.sh" })
    expect(getPushConfig(file)).toBeNull()

    resetPushConfigCache()
    write({ topic: "" })
    expect(getPushConfig(file)).toBeNull()

    resetPushConfigCache()
    write({ topic: "   " })
    expect(getPushConfig(file)).toBeNull()
  })

  it("returns null for malformed JSON, a JSON array, or a bare scalar", () => {
    for (const contents of ["{not json", "[1,2,3]", '"just-a-string"']) {
      resetPushConfigCache()
      write(contents)
      expect(getPushConfig(file)).toBeNull()
    }
  })

  it("rejects a topic outside ntfy's charset instead of silently never delivering", () => {
    for (const topic of ["has spaces", "has/slash", "emoji-🤖", "a".repeat(65)]) {
      resetPushConfigCache()
      write({ topic })
      expect(getPushConfig(file)).toBeNull()
    }
  })

  it("accepts a topic at exactly the 64-char limit", () => {
    write({ topic: "a".repeat(64) })
    expect(getPushConfig(file)?.topic).toHaveLength(64)
  })
})

describe("getPushConfig — resolution", () => {
  it("defaults ntfyUrl to ntfy.sh", () => {
    write({ topic: "cogpit-abc" })
    expect(getPushConfig(file)).toMatchObject({ topic: "cogpit-abc", ntfyUrl: "https://ntfy.sh" })
  })

  it("strips trailing slashes so the click URL never doubles up", () => {
    write({ topic: "t", ntfyUrl: "https://push.example.com///", publicUrl: "https://mb.cogpit.dev/" })
    const config = getPushConfig(file)
    expect(config?.ntfyUrl).toBe("https://push.example.com")
    expect(config?.publicUrl).toBe("https://mb.cogpit.dev")
  })

  it("trims surrounding whitespace on values", () => {
    write({ topic: "  spaced  ", token: "  tk_1  " })
    expect(getPushConfig(file)).toMatchObject({ topic: "spaced", token: "tk_1" })
  })

  it("drops a non-http(s) or unparseable url but keeps the rest usable", () => {
    write({ topic: "t", ntfyUrl: "file:///etc/passwd", publicUrl: "not a url" })
    const config = getPushConfig(file)
    expect(config?.ntfyUrl).toBe("https://ntfy.sh")
    expect(config?.publicUrl).toBeUndefined()
    expect(config?.topic).toBe("t")
  })

  it("allows a self-hosted http url with a path prefix", () => {
    write({ topic: "t", ntfyUrl: "http://192.168.10.232:8080/ntfy" })
    expect(getPushConfig(file)?.ntfyUrl).toBe("http://192.168.10.232:8080/ntfy")
  })

  it("ignores non-string field types", () => {
    write({ topic: "t", token: 12345, publicUrl: { nope: true } })
    const config = getPushConfig(file)
    expect(config?.token).toBeUndefined()
    expect(config?.publicUrl).toBeUndefined()
  })
})

describe("getPushConfig — environment overrides", () => {
  it("works with no file at all, for a systemd unit", () => {
    process.env.COGPIT_NTFY_TOPIC = "from-env"
    expect(getPushConfig(file)).toMatchObject({ topic: "from-env", ntfyUrl: "https://ntfy.sh" })
  })

  it("takes precedence over the file", () => {
    write({ topic: "from-file", ntfyUrl: "https://file.example", publicUrl: "https://file.example" })
    process.env.COGPIT_NTFY_TOPIC = "from-env"
    process.env.COGPIT_NTFY_URL = "https://env.example"
    process.env.COGPIT_PUBLIC_URL = "https://env.public"

    expect(getPushConfig(file)).toMatchObject({
      topic: "from-env",
      ntfyUrl: "https://env.example",
      publicUrl: "https://env.public",
    })
  })

  it("re-resolves when the environment changes without a cache reset", () => {
    write({ topic: "from-file" })
    expect(getPushConfig(file)?.topic).toBe("from-file")

    process.env.COGPIT_NTFY_TOPIC = "later"
    expect(getPushConfig(file)?.topic).toBe("later")
  })
})

describe("getPushConfig — caching", () => {
  it("picks up an edited file without a restart", () => {
    write({ topic: "first" })
    expect(getPushConfig(file)?.topic).toBe("first")

    write({ topic: "second" })
    // Force a distinct mtime; a same-millisecond rewrite is not observable.
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)

    expect(getPushConfig(file)?.topic).toBe("second")
  })

  it("notices the file appearing after start", () => {
    expect(getPushConfig(file)).toBeNull()
    write({ topic: "appeared" })
    expect(getPushConfig(file)?.topic).toBe("appeared")
  })

  it("notices the file being deleted", () => {
    write({ topic: "here" })
    expect(getPushConfig(file)?.topic).toBe("here")
    rmSync(file)
    expect(getPushConfig(file)).toBeNull()
  })
})
