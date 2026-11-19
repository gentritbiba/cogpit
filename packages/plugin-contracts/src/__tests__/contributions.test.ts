// @vitest-environment node
import { describe, expect, it } from "vitest"
import { MEDIA_LIMIT_BYTES, parseConnectionDefinition, parseFrameMessage, parseManifest, parsePluginBlockLanguage, parsePluginMedia, parsePluginUpload, supportsPluginHost, validateSettings } from "../index.js"

const base = { manifestVersion: 1, id: "example.skills", publisher: "example", name: "Skills", version: "1.0.0", runtime: "browser-iife-v1", engines: { pluginApi: "^1.2.0", client: "*", host: "*" }, requires: { client: {}, host: {} }, permissions: {}, stateVersion: 1 }
const skill = { id: "read", title: "Read", description: "Reading guidance", source: "skills/read/SKILL.md" }
const settings = { scope: "plugin" as const, fields: [{ id: "speed", label: "Speed", type: "number" as const, default: 1, min: 0.5, max: 2 }] }

describe("independent plugin contributions", () => {
  it("supports skills-only and settings-only packages without executable entries", () => {
    expect(parseManifest({ ...base, contributes: { skills: [skill] } }).entry).toBeUndefined()
    expect(parseManifest({ ...base, contributes: { settings } }).contributes.panels).toEqual([])
  })
  it("checks the host's actual app, API, protocol and capabilities before providing skills", () => {
    const manifest = parseManifest({ ...base, engines: { ...base.engines, host: ">=3.0.0" }, requires: { client: {}, host: { "skills.context": "^1.0.0" } }, contributes: { skills: [skill] } })
    const host = { appVersion: "3.3.6", apiVersions: ["1.2.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: { "skills.context": "1.0.0" }, platform: "linux", registryRevision: 1 }
    expect(supportsPluginHost(manifest, host)).toBe(true)
    for (const changed of [{ appVersion: "2.0.0" }, { apiVersions: ["1.1.0"] }, { protocolVersions: [] }, { manifestVersions: [] }, { runtimes: [] }, { capabilities: {} }]) expect(supportsPluginHost(manifest, { ...host, ...changed })).toBe(false)
  })
  it("requires an entry for visual contributions and rejects empty/duplicate contributions", () => {
    expect(() => parseManifest({ ...base, contributes: {} })).toThrow()
    expect(() => parseManifest({ ...base, contributes: { chatBlocks: [{ id: "speech", title: "Speech" }] } })).toThrow()
    expect(() => parseManifest({ ...base, contributes: { skills: [skill, skill] } })).toThrow()
    expect(() => parseManifest({ ...base, style: "plugin.css", contributes: { skills: [skill] } })).toThrow()
  })
  it("validates defaults, scalar settings and strict bounds", () => {
    expect(validateSettings(settings, {})).toEqual({ speed: 1 })
    expect(validateSettings(settings, { speed: 0.75 })).toEqual({ speed: 0.75 })
    for (const values of [{ speed: 3 }, { speed: "1" }, { speed: Infinity }, { token: "undeclared" }]) expect(() => validateSettings(settings, values)).toThrow()
    expect(() => parseManifest({ ...base, contributes: { settings: { ...settings, fields: [{ ...settings.fields[0], default: 5 }] } } })).toThrow()
  })
  it("recognizes only namespaced plugin block languages", () => {
    expect(parsePluginBlockLanguage("cogpit:example.skills:speech")).toEqual({ pluginId: "example.skills", blockId: "speech" })
    for (const lang of [null, "speech", "cogpit:other:speech", "cogpit:../example:speech", "cogpit:example.skills:speech extra"]) expect(parsePluginBlockLanguage(lang)).toBeNull()
  })
  it("requires session actions to reference a declared skill and bounds their prompt", () => {
    const action = { id: "summary", title: "Spoken summary", skill: "read", prompt: "Give a brief spoken summary." }
    expect(parseManifest({ ...base, contributes: { skills: [skill], sessionActions: [action] } }).contributes.sessionActions).toHaveLength(1)
    expect(() => parseManifest({ ...base, contributes: { skills: [skill], sessionActions: [{ ...action, skill: "missing" }] } })).toThrow()
    expect(() => parseManifest({ ...base, contributes: { skills: [skill], sessionActions: [{ ...action, prompt: " " }] } })).toThrow()
  })
  it("bounds binary replies separately from JSON and rejects empty/unsupported media", () => {
    const media = { mimeType: "audio/mpeg", bytes: new Uint8Array([255, 251, 1]).buffer }
    expect(parsePluginMedia(media)).toEqual(media)
    expect(parseFrameMessage({ protocol: 1, type: "media-result", id: "r1", value: media })).toMatchObject({ type: "media-result", value: media })
    for (const value of [{ ...media, mimeType: "text/html" }, { ...media, bytes: new ArrayBuffer(0) }, { ...media, bytes: new ArrayBuffer(MEDIA_LIMIT_BYTES + 1) }, { ...media, secret: "forged" }]) expect(() => parsePluginMedia(value)).toThrow()
  })
  it("accepts Cogpit-drawn icons on session actions only from the declared set", () => {
    const action = { id: "summary", title: "Spoken summary", skill: "read", prompt: "Give a brief spoken summary.", icon: "speaker" }
    expect(parseManifest({ ...base, contributes: { skills: [skill], sessionActions: [action] } }).contributes.sessionActions?.[0].icon).toBe("speaker")
    expect(() => parseManifest({ ...base, contributes: { skills: [skill], sessionActions: [{ ...action, icon: "images/logo.png" }] } })).toThrow()
  })
  it("binds dictation to a granted connection operation and a transcript pointer", () => {
    const permissions = { connections: [{ id: "speech", definition: "connections/speech.json", operations: ["transcribe"] }] }
    const dictation = { title: "Dictate", connection: "speech", operation: "transcribe", text: "/text" }
    expect(parseManifest({ ...base, permissions, contributes: { dictation } }).contributes.dictation).toEqual(dictation)
    expect(() => parseManifest({ ...base, permissions, contributes: { dictation: { ...dictation, operation: "synthesize" } } })).toThrow()
    expect(() => parseManifest({ ...base, contributes: { dictation } })).toThrow()
    expect(() => parseManifest({ ...base, permissions, contributes: { dictation: { ...dictation, text: "text" } } })).toThrow()
  })
  it("binds publishing to two granted operations of one connection", () => {
    const permissions = { connections: [{ id: "share", definition: "connections/share.json", operations: ["publish", "unpublish"] }] }
    const publish = { title: "Share host", connection: "share", operation: "publish", unpublish: "unpublish", url: "/url", slug: "/slug" }
    expect(parseManifest({ ...base, permissions, contributes: { publish } }).contributes.publish).toEqual(publish)
    expect(() => parseManifest({ ...base, contributes: { publish } })).toThrow()
    expect(() => parseManifest({ ...base, permissions: { connections: [{ ...permissions.connections[0], operations: ["publish"] }] }, contributes: { publish } })).toThrow()
    expect(() => parseManifest({ ...base, permissions, contributes: { publish: { ...publish, unpublish: "publish" } } })).toThrow()
    expect(() => parseManifest({ ...base, permissions, contributes: { publish: { ...publish, url: "url" } } })).toThrow()
  })
  it("accepts HTML page uploads only as text/html within the media limit", () => {
    const page = { mimeType: "text/html", bytes: new TextEncoder().encode("<p>x").buffer }
    expect(parsePluginUpload(page)).toEqual(page)
    expect(parsePluginUpload({ mimeType: "audio/wav", bytes: new Uint8Array([1]).buffer }).mimeType).toBe("audio/wav")
    for (const value of [{ ...page, bytes: new ArrayBuffer(0) }, { ...page, bytes: new ArrayBuffer(MEDIA_LIMIT_BYTES + 1) }, { ...page, mimeType: "text/plain" }]) expect(() => parsePluginUpload(value)).toThrow()
    expect(() => parsePluginMedia(page)).toThrow()
    const operation = { audience: "setup", method: "GET", origin: "https://share.example.com", path: [{ literal: "check" }], args: {}, query: {} }
    const definition = (upload: unknown) => ({ version: 1, id: "share", label: "Share", secret: { id: "key", label: "Key" }, auth: { header: "Authorization", scheme: "bearer" }, validationOperation: "validate", resources: {},
      operations: { validate: operation, publish: { ...operation, audience: "panel", method: "POST", path: [{ literal: "publish" }], upload } } })
    expect(parseConnectionDefinition(definition({ type: "html", mimeTypes: ["text/html"], maxBytes: 1024 })).operations.publish.upload?.type).toBe("html")
    for (const upload of [{ type: "html", mimeTypes: ["text/plain"], maxBytes: 1024 }, { type: "html", mimeTypes: ["text/html", "text/html"], maxBytes: 1024 }, { type: "html", mimeTypes: ["text/html"], maxBytes: MEDIA_LIMIT_BYTES + 1 }]) {
      expect(() => parseConnectionDefinition(definition(upload))).toThrow()
    }
  })
})
