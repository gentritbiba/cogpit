// @vitest-environment node
import { describe, expect, it } from "vitest"
import { CONTRACT_LIMITS, ContractValidationError, evaluateCompatibility, parseConnectionDefinition, parseFrameMessage, parseIntegrationRequest, parseJson, parseManifest, parseMethodResult, parsePluginContext } from "../index.js"

function manifestInput() {
  return {
    manifestVersion: 1, id: "example.sample", publisher: "example", name: "Sample", version: "1.0.0",
    runtime: "browser-iife-v1", entry: "dist/plugin.js",
    engines: { pluginApi: "^1.0.0", client: ">=2.7.0", host: ">=2.7.0" },
    requires: { client: { "workspace.panel": "^1.0.0" }, host: {} },
    contributes: { panels: [{ id: "sample", title: "Sample", icon: "assets/icon.png" }] },
    permissions: {}, stateVersion: 1,
  }
}
function descriptor() {
  return { appVersion: "2.7.0", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: { "workspace.panel": "1.0.0" }, browser: [], platform: "linux", registryRevision: 0 }
}
function definitionInput() {
  return {
    version: 1, id: "unknown", label: "Unknown service", secret: { id: "token", label: "Token" },
    auth: { header: "X-Provider-Token", scheme: "raw" }, validationOperation: "validate",
    resources: { item: { label: "Item", options: { operation: "list", items: "/items", id: "/id", label: "/name" } } },
    operations: {
      validate: { audience: "setup", origin: "https://fixture.example", method: "GET", path: [{ literal: "me" }], args: {}, query: {} },
      list: { audience: "setup", origin: "https://fixture.example", method: "GET", path: [{ literal: "items" }], args: {}, query: {} },
      read: { audience: "panel", origin: "https://fixture.example", method: "GET", path: [{ literal: "items" }, { resource: "item" }], args: {}, query: {} },
    },
  }
}

describe("public manifest validation", () => {
  it("accepts the minimal self-contained panel and supplies explicit defaults", () => {
    const manifest = parseManifest(manifestInput())
    expect(manifest.protocol).toBe(1)
    expect(manifest.optional).toEqual({ client: {}, host: {} })
    expect(manifest.permissions.connections).toEqual([])
  })
  it.each(["../plugin.js", "/plugin.js", "a\\plugin.js", "C:/plugin.js", "a/CON.js", "a/../plugin.js", "a//plugin.js", "a./plugin.js"])("rejects unsafe entry %s", (entry) => {
    expect(() => parseManifest({ ...manifestInput(), entry })).toThrow(ContractValidationError)
  })
  it.each(["1.0", "01.0.0", "v1.0.0", "1.0.0junk", "1.0.0-01"])("rejects malformed version %s", (version) => {
    expect(() => parseManifest({ ...manifestInput(), version })).toThrow()
  })
  it("rejects unknown fields, majors, runtimes, permissions and publisher mismatch", () => {
    const input = manifestInput()
    for (const change of [{ unexpected: true }, { manifestVersion: 2 }, { runtime: "node" }, { id: "other.sample" }, { permissions: { shell: ["execute"] } }]) {
      expect(() => parseManifest({ ...input, ...change })).toThrow()
    }
    expect(() => parseManifest({ ...input, id: "cogpit.browser", publisher: "cogpit" })).toThrow()
  })
  it("rejects duplicate panels and optional capabilities already required", () => {
    const input = manifestInput()
    expect(() => parseManifest({ ...input, contributes: { panels: [...input.contributes.panels, ...input.contributes.panels] } })).toThrow()
    expect(() => parseManifest({ ...input, optional: input.requires })).toThrow()
  })
  it("reports a field path for author errors", () => {
    try { parseManifest({ ...manifestInput(), version: "bad" }); throw new Error("accepted") }
    catch (error) { expect((error as ContractValidationError).issues).toContainEqual(expect.objectContaining({ path: "$.version" })) }
  })
})

describe("bounded JSON values", () => {
  it("copies data without retaining mutable input references", () => {
    const input = { nested: [true, 2, "text", null] }
    const output = parseJson(input)
    expect(output).toEqual(input)
    input.nested.push("changed")
    expect(output).not.toEqual(input)
  })
  it.each([undefined, NaN, Infinity, BigInt(1), new Date(), /regex/u, new Map(), [undefined], new Array(2)])("rejects non-JSON values", (value) => {
    expect(() => parseJson(value)).toThrow()
  })
  it("rejects cycles, accessors, symbols and hidden array properties", () => {
    const cycle: unknown[] = []; cycle.push(cycle)
    let getterCalls = 0
    const getter = { get secret() { getterCalls++; return "secret" } }
    const array = [1]; Object.defineProperty(array, "hidden", { value: 2 })
    for (const value of [cycle, getter, { [Symbol("x")]: 1 }, array, JSON.parse('{"__proto__":{}}')]) expect(() => parseJson(value)).toThrow()
    expect(getterCalls).toBe(0)
  })
  it("enforces UTF-8 bytes, depth and aggregate node budgets", () => {
    expect(() => parseJson("😀".repeat(20), { maxBytes: 64 })).toThrow()
    expect(() => parseJson({ a: { b: 1 } }, { maxDepth: 1 })).toThrow()
    expect(() => parseJson(Array(4097).fill(null))).toThrow()
  })
})

describe("declarative connection definitions", () => {
  it.each(["Authorization", "X-Figma-Token", "X-Unknown-Token"])("supports %s through declarations", (header) => {
    expect(parseConnectionDefinition({ ...definitionInput(), auth: { header, scheme: header === "Authorization" ? "bearer" : "raw" } }).auth.header).toBe(header)
  })
  it.each(["Host", "Cookie", "X-Forwarded-Host", "X-HTTP-Method-Override"])("rejects credential header %s", (header) => {
    expect(() => parseConnectionDefinition({ ...definitionInput(), auth: { header, scheme: "raw" } })).toThrow()
  })
  it.each(["http://fixture.example", "https://127.0.0.1", "https://app.local", "https://fixture.example/path", "https://fixture.example:8443", "https://user@fixture.example"])("rejects origin %s", (origin) => {
    const input = definitionInput(); input.operations.read.origin = origin
    expect(() => parseConnectionDefinition(input)).toThrow()
  })
  it("rejects missing setup operations and unknown resources", () => {
    expect(() => parseConnectionDefinition({ ...definitionInput(), validationOperation: "read" })).toThrow()
    const input = definitionInput(); input.operations.read.path = [{ resource: "different" }]
    expect(() => parseConnectionDefinition(input)).toThrow()
  })
  it("rejects argument substitution for selected resources", () => {
    const input = definitionInput()
    const read = { ...input.operations.read, args: { item: { type: "string", maxLength: 64, required: true } }, path: [{ arg: "item" }] }
    expect(() => parseConnectionDefinition({ ...input, operations: { ...input.operations, read } })).toThrow()
  })
})

describe("client and selected-host compatibility", () => {
  it("accepts current versions and additive API minors", () => {
    const manifest = parseManifest(manifestInput())
    expect(evaluateCompatibility(manifest, descriptor(), descriptor()).compatible).toBe(true)
    expect(evaluateCompatibility(manifest, { ...descriptor(), apiVersions: ["1.3.0"] }, { ...descriptor(), apiVersions: ["1.1.0"] }).apiVersion).toBe("1.1.0")
  })
  it.each(["<=1.0.0", "1.0.0", "<1.1.0", "^2.0.0 || <=1.0.0"])("resolves older supported API range %s", (pluginApi) => {
    const input = manifestInput(); input.engines.pluginApi = pluginApi
    const result = evaluateCompatibility(parseManifest(input), { ...descriptor(), apiVersions: ["1.3.0"] }, { ...descriptor(), apiVersions: ["1.3.0"] })
    expect(result.compatible).toBe(true)
    expect(result.apiVersion).toBe("1.0.0")
  })
  it.each(["client", "host"] as const)("attributes old app version to %s", (side) => {
    const old = { ...descriptor(), appVersion: "2.6.0" }
    const result = evaluateCompatibility(parseManifest(manifestInput()), side === "client" ? old : descriptor(), side === "host" ? old : descriptor())
    expect(result.issues).toContainEqual(expect.objectContaining({ side, code: "APP_VERSION" }))
  })
  it("separates optional capabilities from blocking requirements", () => {
    const manifest = parseManifest({ ...manifestInput(), optional: { client: {}, host: { "storage.json": "^1.0.0" } } })
    const result = evaluateCompatibility(manifest, descriptor(), descriptor())
    expect(result.compatible).toBe(true)
    expect(result.unavailableOptional).toEqual([{ side: "host", name: "storage.json", required: "^1.0.0", actual: null }])
  })
  it("rejects unknown app versions, missing capabilities, prerequisites and protocol/API mismatch", () => {
    const manifest = parseManifest({ ...manifestInput(), browser: ["web-crypto"] })
    const result = evaluateCompatibility(manifest, { ...descriptor(), appVersion: "unknown", capabilities: {}, protocolVersions: [2] }, { ...descriptor(), apiVersions: ["2.0.0"] })
    expect(result.compatible).toBe(false)
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(new Set(["APP_VERSION", "CAPABILITY", "PROTOCOL_VERSION", "BROWSER", "API_VERSION"]))
  })
  it("requires prerelease opt-in and rejects revoked packages regardless", () => {
    const manifest = parseManifest({ ...manifestInput(), version: "1.0.1-dev.1" })
    expect(evaluateCompatibility(manifest, descriptor(), descriptor()).compatible).toBe(false)
    expect(evaluateCompatibility(manifest, descriptor(), descriptor(), { allowPrerelease: true }).compatible).toBe(true)
    expect(evaluateCompatibility(manifest, descriptor(), descriptor(), { allowPrerelease: true, revoked: true }).compatible).toBe(false)
  })
})

describe("wire schema", () => {
  it("accepts typed operations and rejects host identity fields", () => {
    const message = { protocol: 1, type: "request", id: "r_1", method: "composer.append", params: { text: "Draft" } }
    expect(parseFrameMessage(message)).toEqual(message)
    for (const extra of [{ lease: "secret" }, { pluginId: "other.plugin" }, { principal: "admin" }]) expect(() => parseFrameMessage({ ...message, ...extra })).toThrow()
    expect(() => parseFrameMessage({ ...message, params: { text: "Draft", submit: true } })).toThrow()
  })
  it("rejects unsupported protocol, method, URL scheme and unbounded payload", () => {
    const message = { protocol: 1, type: "request", id: "r_1", method: "navigation.openExternal", params: { url: "https://example.com" } }
    for (const change of [{ protocol: 2 }, { method: "shell.exec" }, { params: { url: "file:///tmp/x" } }, { params: { url: "https://user:secret@example.com" } }]) expect(() => parseFrameMessage({ ...message, ...change })).toThrow()
    expect(() => parseFrameMessage({ protocol: 1, type: "result", id: "r_1", value: "x".repeat(CONTRACT_LIMITS.responseBytes) })).toThrow()
  })
  it("accepts bounded provider pages without widening frame requests or stored values", () => {
    const tasks = Array.from({ length: 300 }, (_, index) => ({ id: String(index), name: "Example task", description: "x".repeat(600), tags: ["one", "two"], closed: false }))
    const value = { tasks }
    expect(JSON.stringify(value).length).toBeGreaterThan(CONTRACT_LIMITS.messageBytes)
    expect(parseMethodResult("connections.request", value)).toEqual(value)
    expect(parseFrameMessage({ protocol: 1, type: "result", id: "r1", value })).toEqual({ protocol: 1, type: "result", id: "r1", value })
    expect(() => parseFrameMessage({ protocol: 1, type: "request", id: "r1", method: "connections.request", params: { handle: "service", operationId: "read", args: { query: "x".repeat(4096) } } })).toThrow()
    expect(() => parseFrameMessage({ protocol: 1, type: "request", id: "r1", method: "storage.set", params: { key: "large", value } })).toThrow()
    expect(() => parseMethodResult("connections.request", Array(CONTRACT_LIMITS.responseNodes).fill(null))).toThrow()
    expect(() => parseJson([], { maxNodes: CONTRACT_LIMITS.responseNodes + 17 })).toThrow()
  })
  it("does not invoke a type getter while choosing response limits", () => {
    const getter = { get type() { throw new Error("Getter invoked") } }
    expect(() => parseFrameMessage(getter)).toThrow(ContractValidationError)
  })
  it("rejects transcripts and host paths in minimal context", () => {
    const context = { project: { id: "project-1", name: "Project" }, theme: { mode: "dark", tokens: {} }, locale: "en", visible: true, reducedMotion: false }
    expect(parsePluginContext(context)).toEqual(context)
    expect(() => parsePluginContext({ ...context, session: { transcript: "private" } })).toThrow()
  })
})


describe("public connection status", () => {
  it("accepts only credential-free connection and resource status", () => {
    const value = { configured: true, readOnly: false, selected: { workspace: { id: "1", label: "Work" } } }
    expect(parseMethodResult("connections.status", value)).toEqual(value)
    for (const invalid of [null, { ...value, secret: "credential" }, { ...value, selected: { workspace: { id: "1", label: "Work", token: "credential" } } }]) {
      expect(() => parseMethodResult("connections.status", invalid)).toThrow()
    }
  })
})


describe("native integration contracts", () => {
  it("requires bounded named operations and denies provider-controlled workspace or commands", () => {
    const valid = { integration: "github", operation: "actions", limit: 20 }
    expect(parseIntegrationRequest(valid)).toEqual(valid)
    for (const invalid of [{ ...valid, cwd: "/other" }, { ...valid, command: "gh auth token" }, { ...valid, endpoint: "/user" }, { ...valid, limit: 31 }, { ...valid, integration: "vercel" }, { integration: "github", operation: "arbitrary" }, { integration: "vercel", operation: "buildLogs", deploymentId: "../project" }, { integration: "cloudflare", operation: "deployments", environment: "staging; rm -rf /" }, { integration: "cloudflare", operation: "version", versionId: "latest" }, { integration: "cloudflare", operation: "workspace", cwd: "/other" }]) {
      expect(() => parseIntegrationRequest(invalid)).toThrow(ContractValidationError)
    }
    const cloudflare = { integration: "cloudflare", operation: "version", environment: "staging", versionId: "a5d6631d-f96f-4917-bec2-5a31678c58fe" }
    expect(parseIntegrationRequest(cloudflare)).toEqual(cloudflare)
  })
  it("accepts read grants and rejects duplicate or unknown grants", () => {
    const input = manifestInput()
    expect(parseManifest(input).permissions.integrations).toEqual([])
    const grant = { id: "github", operations: ["pulls", "pullSessions"] }
    expect(parseManifest({ ...input, permissions: { integrations: [grant] } }).permissions.integrations).toEqual([grant])
    for (const integrations of [[grant, grant], [{ ...grant, operations: ["pulls", "pulls"] }], [{ id: "github", operations: ["write"] }], [{ id: "shell", operations: ["exec"] }]]) {
      expect(() => parseManifest({ ...input, permissions: { integrations } })).toThrow(ContractValidationError)
    }
  })
  it("validates integration results at the public response size limit", () => {
    const value = { ok: true, data: { body: "x".repeat(100000) } }
    expect(parseMethodResult("integrations.request", value)).toEqual(value)
    expect(() => parseMethodResult("integrations.request", { ok: false, error: { code: "failed", message: "x".repeat(513) } })).toThrow()
    expect(() => parseMethodResult("integrations.request", { ok: true, data: undefined })).toThrow()
  })
})
