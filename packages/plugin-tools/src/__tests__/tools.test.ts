// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createArchive } from "../archive"
import { signBundle, targetPathFor } from "../bundle"
import { createPublisher, loadPublisher, rootFingerprint, savePublisher } from "../publisher"
import { main } from "../cli"

const ICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64")
const manifest = {
  manifestVersion: 1, id: "cogpit.sample", publisher: "cogpit", name: "Sample", version: "1.2.0", runtime: "browser-iife-v1", entry: "plugin.js", style: "plugin.css",
  engines: { pluginApi: "^1.0.0", client: ">=2.6.6", host: ">=2.6.6" }, protocol: 1, requires: { client: {}, host: {} },
  contributes: { panels: [{ id: "sample", title: "Sample", icon: "assets/icon.png" }] }, permissions: {}, stateVersion: 1,
}
let directory: string
let built: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cogpit-plugin-tools-"))
  built = join(directory, "built")
  await mkdir(join(built, "assets"), { recursive: true })
  await writeFile(join(built, "plugin.json"), JSON.stringify(manifest))
  await writeFile(join(built, "plugin.js"), "document.body.textContent = 'sample'")
  await writeFile(join(built, "plugin.css"), "body { color: red }")
  await writeFile(join(built, "LICENSE"), "MIT")
  await writeFile(join(built, "assets", "icon.png"), ICON)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe("plugin archives", () => {
  it("packs a built directory into the host archive format with sorted, typed files", async () => {
    const archive = await createArchive(built)
    expect(archive.manifest.id).toBe("cogpit.sample")
    const payload = JSON.parse(archive.payload.toString("utf8"))
    expect(payload.archiveVersion).toBe(1)
    expect(payload.files.map((file: { path: string; mime: string }) => [file.path, file.mime])).toEqual([
      ["LICENSE", "text/plain"], ["assets/icon.png", "image/png"], ["plugin.css", "text/css"], ["plugin.js", "text/javascript"], ["plugin.json", "application/json"],
    ])
    expect(Buffer.from(payload.files[1].content, "base64")).toEqual(ICON)
  })

  it("re-signs an official package under a development publisher and can replace the version", async () => {
    const archive = await createArchive(built, { publisher: "dev-me", version: "1.2.0-dev.3" })
    expect(archive.manifest).toMatchObject({ id: "dev-me.sample", publisher: "dev-me", version: "1.2.0-dev.3" })
    const stored = JSON.parse(Buffer.from(JSON.parse(archive.payload.toString("utf8")).files.find((file: { path: string }) => file.path === "plugin.json").content, "base64").toString("utf8"))
    expect(stored).toMatchObject({ id: "dev-me.sample", publisher: "dev-me" })
  })

  it("rejects unsupported files, missing entries and bad manifests", async () => {
    await writeFile(join(built, "plugin.wasm"), "")
    await expect(createArchive(built)).rejects.toThrow("Unsupported file type in package: plugin.wasm")
    await rm(join(built, "plugin.wasm"))
    await rm(join(built, "assets", "icon.png"))
    await expect(createArchive(built)).rejects.toThrow("Missing raster icon: assets/icon.png")
    await writeFile(join(built, "assets", "icon.png"), ICON)
    await writeFile(join(built, "plugin.json"), JSON.stringify({ ...manifest, id: "other.sample" }))
    await expect(createArchive(built)).rejects.toThrow()
  })
})

describe("publisher keys and bundles", () => {
  it("creates a dev publisher whose root fingerprint is the SHA-256 of the root bytes and persists it privately", async () => {
    const store = createPublisher("dev-me")
    expect(() => createPublisher("cogpit")).toThrow()
    const root = JSON.parse(store.root)
    expect(root.signed).toMatchObject({ _type: "root", version: 1, consistent_snapshot: true })
    expect(Object.keys(root.signed.roles).sort()).toEqual(["root", "snapshot", "targets", "timestamp"])
    expect(rootFingerprint(store)).toMatch(/^[a-f0-9]{64}$/)
    const path = join(directory, "keys", "dev-me.json")
    await savePublisher(path, store)
    const mode = (await stat(path)).mode
    if (process.platform === "win32") expect(mode & 0o600).toBe(0o600)
    else expect(mode & 0o777).toBe(0o600)
    expect(await loadPublisher(path)).toEqual(store)
  })

  it("signs consecutive bundles with increasing metadata versions while retaining earlier targets", async () => {
    let store = createPublisher("dev-me")
    const first = signBundle(store, await createArchive(built, { publisher: "dev-me" }))
    expect(first.metadataVersion).toBe(1)
    expect(first.targetPath).toBe("dev-me/dev-me.sample/1.2.0/payload.json")
    const bundle = JSON.parse(first.bytes.toString("utf8"))
    expect(bundle).toMatchObject({ bundleVersion: 1, publisher: "dev-me", targetPath: first.targetPath, roots: [] })
    expect(Object.keys(bundle.metadata).sort()).toEqual(["1.snapshot.json", "1.targets.json", "timestamp.json"])
    store = first.publisher
    await writeFile(join(built, "plugin.json"), JSON.stringify({ ...manifest, version: "1.3.0" }))
    const second = signBundle(store, await createArchive(built, { publisher: "dev-me" }))
    expect(second.metadataVersion).toBe(2)
    const targets = JSON.parse(JSON.parse(second.bytes.toString("utf8")).metadata["2.targets.json"])
    expect(Object.keys(targets.signed.targets).sort()).toEqual(["dev-me/dev-me.sample/1.2.0/payload.json", "dev-me/dev-me.sample/1.3.0/payload.json"])
    expect(targets.signed.targets[second.targetPath].custom).toEqual({ publisher: "dev-me", pluginId: "dev-me.sample", version: "1.3.0" })
  })

  it("refuses to reuse a signed version with different contents and rejects foreign publishers", async () => {
    const store = signBundle(createPublisher("dev-me"), await createArchive(built, { publisher: "dev-me" })).publisher
    await writeFile(join(built, "plugin.js"), "document.body.textContent = 'changed'")
    await expect(createArchive(built, { publisher: "dev-me" }).then(archive => signBundle(store, archive))).rejects.toThrow(/already signed with different contents/)
    await expect(createArchive(built).then(archive => signBundle(store, archive))).rejects.toThrow(/does not match key file publisher/)
    expect(targetPathFor({ manifest: { publisher: "dev-me", id: "dev-me.x", version: "2.0.0" } as never })).toBe("dev-me/dev-me.x/2.0.0/payload.json")
  })
})

describe("cogpit-plugin CLI", () => {
  it("runs keygen, pack --as --dev and fingerprint end to end", async () => {
    const keys = join(directory, "publisher.json"), out = join(directory, "sample.cogpit-plugin")
    const logs: string[] = []
    const original = console.log
    console.log = (line: string) => { logs.push(line) }
    try {
      expect(await main(["keygen", "--publisher", "dev-me", "--out", keys])).toBe(0)
      expect(await main(["keygen", "--publisher", "dev-me", "--out", keys])).toBe(1)
      const root = await readFile(join(directory, "publisher.root.json"), "utf8")
      expect(JSON.parse(root).signed._type).toBe("root")
      expect(await main(["pack", built, "--keys", keys, "--out", out, "--as", "dev-me", "--dev"])).toBe(0)
      const bundle = JSON.parse(await readFile(out, "utf8"))
      expect(bundle.targetPath).toBe("dev-me/dev-me.sample/1.2.0-dev.1/payload.json")
      expect(await main(["pack", built, "--keys", keys, "--out", out, "--as", "dev-me", "--dev"])).toBe(0)
      expect(JSON.parse(await readFile(out, "utf8")).targetPath).toBe("dev-me/dev-me.sample/1.2.0-dev.2/payload.json")
      expect((await loadPublisher(keys)).metadataVersion).toBe(2)
      expect(await main(["fingerprint", "--keys", keys])).toBe(0)
      expect(logs.at(-1)).toMatch(/^[a-f0-9]{64}$/)
      expect(await main(["pack", built, "--keys", keys, "--out", out])).toBe(1)
      expect(await main(["nonsense"])).toBe(1)
    } finally {
      console.log = original
    }
  })
})
