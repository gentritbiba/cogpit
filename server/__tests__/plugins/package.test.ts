// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseJsonText } from "../../plugins/json"
import { decodeBase64, decodeInstallBundle, inspectPackage, PACKAGE_LIMITS, validatePackagePath } from "../../plugins/package"

const utf8 = (text: string) => Buffer.from(text, "utf8")
const json = (value: unknown) => utf8(JSON.stringify(value))
const icon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")

interface ArchiveEntry { path: string; mime: string; content: string }
const file = (path: string, mime: string, bytes: string | Buffer): ArchiveEntry => ({
  path, mime, content: (typeof bytes === "string" ? utf8(bytes) : bytes).toString("base64"),
})
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: "fixture.sample",
    publisher: "fixture",
    name: "Sample fixture",
    version: "1.0.0",
    runtime: "browser-iife-v1",
    entry: "dist/plugin.js",
    engines: { pluginApi: "^1.0.0", client: ">=2.6.6", host: ">=2.6.6" },
    requires: { client: {}, host: {} },
    contributes: { panels: [{ id: "sample", title: "Sample", icon: "assets/icon.png" }] },
    permissions: {},
    stateVersion: 1,
    ...overrides,
  }
}
function files(manifestBytes = json(manifest())): ArchiveEntry[] {
  return [
    file("plugin.json", "application/json", manifestBytes),
    file("dist/plugin.js", "text/javascript", 'throw new Error("Package inspection must never execute this code")'),
    file("assets/icon.png", "image/png", icon),
  ]
}
const archive = (entries = files(), overrides: Record<string, unknown> = {}) => json({ archiveVersion: 1, files: entries, ...overrides })
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    bundleVersion: 1,
    publisher: "fixture",
    targetPath: "fixture/sample/1.0.0.cogpit-plugin",
    roots: [JSON.stringify({ signed: { version: 2 } })],
    metadata: { "timestamp.json": JSON.stringify({ signed: { version: 1 } }) },
    payload: archive().toString("base64"),
    ...overrides,
  }
}

describe("bounded raw JSON parsing", () => {
  it("preserves valid escaped strings, surrogate pairs, nested arrays and exponent numbers", () => {
    const value = { key: "quotes \" and slash \\ and emoji 😀", values: [null, true, false, -1.5e3], nested: { key: "repeated in a different object" } }
    expect(parseJsonText(json(value), 4096)).toEqual(value)
    expect(parseJsonText(utf8('"\\ud83d\\ude00"'), 4096)).toBe("😀")
    expect(parseJsonText(utf8(" \r\n\t[1] \r\n\t"), 4096)).toEqual([1])
  })

  it.each([
    '{"id":1,"id":2}',
    '{"id":1,"i\\u0064":2}',
    '{"\\u0069d":1,"id":2}',
    '{"nested":{"id":1,"i\\u0064":2}}',
    '[{"id":1,"id":2}]',
    '{"a/b":1,"a\\/b":2}',
    '{"😀":1,"\\ud83d\\ude00":2}',
    '{"__proto__":1,"__proto__":2}',
  ])("rejects duplicate raw keys including escaped aliases: %s", (text) => {
    expect(() => parseJsonText(utf8(text), 4096)).toThrow(/Duplicate JSON key/)
  })

  it.each([
    "", "undefined", "NaN", "01", "-01", ".1", "1.", "1e", "true false", "{}[]", "[1,]", '{"a":1,}',
    '{"a" 1}', "[1 2]", '"\\q"', '"unterminated', '"line\nbreak"', "\u00a0{}", "{}\u00a0",
  ])("rejects malformed JSON: %j", (text) => {
    expect(() => parseJsonText(utf8(text), 4096)).toThrow()
  })

  it.each(['"\\ud800"', '"\\udc00"', '"\\ud800a"', '{"\\ud800":1}', "1e999", "-1e999"])("rejects non-Unicode strings and nonfinite decoded numbers: %s", (text) => {
    expect(() => parseJsonText(utf8(text), 4096)).toThrow()
  })

  it.each([
    Buffer.from([0x22, 0xc0, 0xaf, 0x22]),
    Buffer.from([0x22, 0xed, 0xa0, 0x80, 0x22]),
    Buffer.from([0x22, 0xff, 0x22]),
    Buffer.from([0x22, 0xe2, 0x82]),
  ])("rejects malformed UTF-8 bytes", (bytes) => {
    expect(() => parseJsonText(bytes, 4096)).toThrow()
  })

  it("enforces byte, nesting and node limits", () => {
    expect(parseJsonText(utf8("null"), 4)).toBe(null)
    expect(() => parseJsonText(utf8("null"), 3)).toThrow(/size limit/)
    expect(() => parseJsonText(utf8('"é"'), 3)).toThrow(/size limit/)
    expect(() => parseJsonText(utf8("[".repeat(34) + "0" + "]".repeat(34)), 4096)).toThrow(/complex/)
    expect(() => parseJsonText(json(Array.from({ length: 50_001 }, () => null)), 300_000)).toThrow(/complex/)
  })
})

describe("canonical base64 decoding", () => {
  it("decodes exact boundary bytes and an empty data file", () => {
    expect(decodeBase64("Zm9v", 3)).toEqual(utf8("foo"))
    expect(decodeBase64("Zg==", 1)).toEqual(utf8("f"))
    expect(decodeBase64("", 0)).toEqual(Buffer.alloc(0))
  })

  it.each(["Zg", "Zg=", "Zh==", "Zm9=", "Zg==\n", " Zg==", "-w==", "_w==", "A===", "=", "====", "AA=A", "####", "Zg===="])("rejects noncanonical or malformed encoding: %j", (text) => {
    expect(() => decodeBase64(text, 10)).toThrow()
  })

  it("bounds decoded length even when the encoded length fits the padding allowance", () => {
    expect(() => decodeBase64("Zm9v", 2)).toThrow(/oversized/)
    expect(() => decodeBase64("Zm9v", 0)).toThrow(/oversized/)
  })
})

describe("portable package paths", () => {
  it.each(["plugin.json", "dist/plugin.js", "assets/icon-2.png", "LICENSE", "nested/_file.md"])("accepts portable relative path %s", (path) => {
    expect(() => validatePackagePath(path)).not.toThrow()
  })

  it.each([
    "", "/etc/passwd", "../outside.js", "dist/../outside.js", "dist/./plugin.js", "dist//plugin.js", "dist/plugin.js/",
    "C:\\temp\\plugin.js", "C:/temp/plugin.js", "\\\\server\\share\\plugin.js", "//server/share/plugin.js", "dist\\plugin.js",
    "dist/plugin.js:stream", "dist/plugin.js.", "dist/plugin.js ", "dist /plugin.js", "dist/%2e%2e/plugin.js", "dist/%252e%252e/plugin.js",
    "dist/con", "dist/CON.txt", "dist/prn.js", "dist/aux.css", "dist/nul", "dist/com1.js", "dist/COM9", "dist/lpt1.txt", "dist/LPT9.js",
    "dist/com¹.js", "dist/😀.png", "dist/é.png", "dist/\u0000.js", "dist/\n.js", "x".repeat(241),
  ])("rejects malicious or nonportable path %j", (path) => {
    expect(() => validatePackagePath(path)).toThrow()
  })
})

describe("install bundle envelope", () => {
  it("decodes bounded data without treating structural validity as signature verification", () => {
    const input = envelope()
    const result = decodeInstallBundle(json(input))
    expect(result.publisher).toBe("fixture")
    expect(result.targetPath).toBe(input.targetPath)
    expect(result.roots).toEqual([utf8(input.roots[0]!)])
    expect(result.metadata.get("timestamp.json")).toEqual(utf8(input.metadata["timestamp.json"]!))
    expect(result.payload).toEqual(archive())
  })

  it.each([
    { compression: "gzip" }, { signature: "outside-the-fixed-envelope" }, { bundleVersion: 2 },
    { payload: "Zh==" }, { payload: "" }, { targetPath: "../package" }, { targetPath: "C:/package" },
    { roots: Array.from({ length: 33 }, () => "{}") },
    { metadata: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`role${index}.json`, "{}"])) },
    { roots: ['{"version":1,"versi\\u006fn":2}'] },
    { metadata: { "timestamp.json": '{"version":1,"versi\\u006fn":2}' } },
  ])("rejects malformed or unsupported envelope data", (override) => {
    expect(() => decodeInstallBundle(json(envelope(override)))).toThrow()
  })

  it("rejects duplicate envelope keys before schema validation", () => {
    const text = JSON.stringify(envelope()).replace('"bundleVersion":1', '"bundleVersion":1,"bundle\\u0056ersion":1')
    expect(() => decodeInstallBundle(utf8(text))).toThrow(/Duplicate JSON key/)
  })

  it.each(["../timestamp.json", "dir/timestamp.json", "dir\\timestamp.json", "%2e%2e.json", "root.json", "2.root.json", "01.snapshot.json", "timestamp", "__proto__.json"])("rejects unsupported metadata filename %s", (name) => {
    expect(() => decodeInstallBundle(json(envelope({ metadata: { [name]: "{}" } })))).toThrow(/metadata filename/)
  })

  it("accepts versioned metadata names without permitting root-role replacement", () => {
    const metadata = { "2.snapshot.json": "{}", "3.targets.json": "{}", "delegated-role.json": "{}" }
    expect([...decodeInstallBundle(json(envelope({ metadata }))).metadata.keys()]).toEqual(Object.keys(metadata))
  })

  it("rejects oversized uploads and UTF-8 metadata bytes", () => {
    expect(() => decodeInstallBundle(Buffer.alloc(PACKAGE_LIMITS.upload + 1))).toThrow(/size limit/)
    expect(() => decodeInstallBundle(json(envelope({ roots: [JSON.stringify("é".repeat(PACKAGE_LIMITS.metadata / 2))] })))).toThrow()
  })
})

describe("authenticated payload inspection", () => {
  it("returns the exact payload digest, validated manifest and file bytes without executing entry code", () => {
    const payload = archive()
    const result = inspectPackage(payload, "fixture")
    expect(result.manifest.id).toBe("fixture.sample")
    expect(result.digest).toBe(createHash("sha256").update(payload).digest("hex"))
    expect(result.payload).toEqual(payload)
    expect([...result.files.keys()]).toEqual(["plugin.json", "dist/plugin.js", "assets/icon.png"])
    expect(result.files.get("assets/icon.png")?.bytes).toEqual(icon)
    expect(result.connections.size).toBe(0)
  })

  it("accepts one declared stylesheet and text notices", () => {
    const entries = files(json(manifest({ style: "dist/plugin.css" })))
    entries.push(file("dist/plugin.css", "text/css", "body { color: white }"), file("LICENSE", "text/plain", "Fixture license"), file("NOTICE.txt", "text/plain", "Fixture notice"))
    expect(inspectPackage(archive(entries), "fixture").files.size).toBe(6)
  })

  it.each([
    { compression: "gzip" }, { archiveVersion: 2 }, { symlinks: [{ from: "dist/plugin.js", to: "/tmp/outside" }] },
  ])("rejects unsupported archive features", (override) => {
    expect(() => inspectPackage(archive(files(), override), "fixture")).toThrow()
  })

  it.each([
    { type: "symlink", target: "../../outside" }, { type: "hardlink", linkname: "dist/plugin.js" },
    { mode: 0o755 }, { compression: "gzip" }, { executable: true },
  ])("rejects entry link/compression/mode features", (extra) => {
    const entries = files()
    expect(() => inspectPackage(archive([...entries, { ...file("NOTICE", "text/plain", "text"), ...extra }]), "fixture")).toThrow()
  })

  it.each(["plugin.json", "PLUGIN.JSON", "dist/PLUGIN.js", "ASSETS/Icon.PNG"])("rejects duplicate or case-colliding file %s", (path) => {
    expect(() => inspectPackage(archive([...files(), file(path, "text/plain", "collision")]), "fixture")).toThrow(/Duplicate package path/)
  })

  it.each([
    ["dist/plugin.js/child.txt", "text/plain"],
    ["DIST/PLUGIN.JS/child.txt", "text/plain"],
    ["assets/icon.png/nested.txt", "text/plain"],
  ])("rejects file/directory prefix collision %s", (path, mime) => {
    const entries = files()
    expect(() => inspectPackage(archive([...entries, file(path, mime, "child")]), "fixture")).toThrow()
    expect(() => inspectPackage(archive([file(path, mime, "child"), ...entries]), "fixture")).toThrow()
  })

  it.each([
    file("dist/extra.js", "text/javascript", "void 0"),
    file("dist/extra.css", "text/css", "body {}"),
    file("dist/page.html", "text/html", "<script>void 0</script>"),
    file("assets/icon.svg", "image/svg+xml", "<svg/>"),
    file("dist/extra.mjs", "text/javascript", "void 0"),
    file("dist/extra.cjs", "text/javascript", "void 0"),
    file("dist/code.wasm", "application/wasm", Buffer.from([0, 97, 115, 109])),
    file("assets/nested.zip", "application/zip", "PK"),
    file("assets/nested.cogpit-plugin", "application/json", "{}"),
  ])("rejects additional executables, styles, active content and nested archives: $path", (extra) => {
    expect(() => inspectPackage(archive([...files(), extra]), "fixture")).toThrow()
  })

  it.each([
    file("assets/data.txt", "text/html", "<b>wrong MIME</b>"),
    file("assets/config.json", "text/javascript", "{}"),
    file("assets/fake.png", "image/jpeg", icon),
    file("assets/fake.jpg", "image/jpeg", "not JPEG"),
    file("assets/fake.webp", "image/webp", "not WebP"),
    file("assets/fake.png", "image/png", "not PNG"),
    file("assets/bad.txt", "text/plain", Buffer.from([0xff, 0xfe])),
    file("assets/bad.js", "text/javascript", Buffer.from([0xed, 0xa0, 0x80])),
  ])("rejects invalid MIME/content/Unicode for $path", (extra) => {
    expect(() => inspectPackage(archive([...files(), extra]), "fixture")).toThrow()
  })

  it("rejects missing, mismatched or differently owned manifest assets", () => {
    expect(() => inspectPackage(archive(files().slice(1)), "fixture")).toThrow(/Missing plugin.json/)
    expect(() => inspectPackage(archive(files().filter((entry) => entry.path !== "dist/plugin.js")), "fixture")).toThrow(/JavaScript entry/)
    expect(() => inspectPackage(archive(files().filter((entry) => entry.path !== "assets/icon.png")), "fixture")).toThrow(/raster icon/)
    expect(() => inspectPackage(archive(files(json(manifest({ style: "dist/missing.css" })))), "fixture")).toThrow(/stylesheet/)
    expect(() => inspectPackage(archive(), "other-publisher")).toThrow(/publisher/)
    expect(() => inspectPackage(archive(files(json(manifest({ id: "someone-else.sample" })))), "fixture")).toThrow()
  })

  it("rejects duplicate raw archive and manifest keys, including escaped aliases", () => {
    const rawArchive = archive().toString("utf8").replace('"archiveVersion":1', '"archiveVersion":1,"archive\\u0056ersion":1')
    expect(() => inspectPackage(utf8(rawArchive), "fixture")).toThrow(/Duplicate JSON key/)
    const rawManifest = JSON.stringify(manifest()).replace('"publisher":"fixture"', '"publisher":"fixture","publi\\u0073her":"fixture"')
    expect(() => inspectPackage(archive(files(utf8(rawManifest))), "fixture")).toThrow(/Duplicate JSON key/)
  })

  it("enforces archive/file-count/manifest byte limits before use", () => {
    expect(() => inspectPackage(Buffer.alloc(PACKAGE_LIMITS.upload + 1), "fixture")).toThrow(/size limit/)
    const extras = Array.from({ length: PACKAGE_LIMITS.files }, (_, index) => file(`assets/file-${index}.txt`, "text/plain", ""))
    expect(() => inspectPackage(archive([...files(), ...extras]), "fixture")).toThrow()
    const largeManifest = utf8(" ".repeat(PACKAGE_LIMITS.manifest) + JSON.stringify(manifest()))
    expect(() => inspectPackage(archive(files(largeManifest)), "fixture")).toThrow(/size limit/)
  })

  it("rejects noncanonical entry bytes and malformed UTF-8 archives", () => {
    expect(() => inspectPackage(archive([...files(), { path: "assets/data.txt", mime: "text/plain", content: "Zh==" }]), "fixture")).toThrow(/canonical/)
    expect(() => inspectPackage(Buffer.from([0xff, 0xfe]), "fixture")).toThrow()
  })
})
