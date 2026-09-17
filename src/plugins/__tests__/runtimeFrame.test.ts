// @vitest-environment node
import { createHash, webcrypto } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRuntimeFrame, RUNTIME_SHELL_PATH, type RuntimeFrameController } from "../runtimeFrame"
import { prepareRuntimePackage } from "../runtimePayload"
import type { JsonValue, PluginContext, PluginRequest } from "@cogpit/plugin-contracts"

class Port extends EventTarget {
  sent: unknown[] = []
  sentAt: number[] = []
  closed = false
  postMessage(message: unknown) { this.sent.push(message); this.sentAt.push(Date.now()) }
  close() { this.closed = true }
  start() {}
  receive(message: unknown) { this.dispatchEvent(new MessageEvent("message", { data: message })) }
}
class Frame extends EventTarget {
  src = ""
  contentWindow = { postMessage: vi.fn() }
  removeAttribute() { this.src = "" }
  load() { this.dispatchEvent(new Event("load")) }
}
const context: PluginContext = { project: { id: "p1", name: "Project" }, theme: { mode: "dark", tokens: {} }, locale: "en", reducedMotion: false, visible: true }
const cryptoApi = webcrypto as unknown as Crypto
function makePayload(extraFiles: { path: string; mime: string; content: string }[] = [], extraManifest = {}) {
  const manifest = {
    manifestVersion: 1, id: "example.sample", publisher: "example", name: "Sample", version: "1.0.0", runtime: "browser-iife-v1", entry: "dist/plugin.js",
    engines: { pluginApi: "^1.0.0", host: ">=2.7.0", client: ">=2.7.0" }, requires: { client: {}, host: {} },
    contributes: { panels: [{ id: "sample", title: "Sample", icon: "assets/icon.png" }] }, permissions: {}, stateVersion: 1, ...extraManifest,
  }
  const files = [
    { path: "plugin.json", mime: "application/json", content: Buffer.from(JSON.stringify(manifest)).toString("base64") },
    { path: "dist/plugin.js", mime: "text/javascript", content: Buffer.from("globalThis.cogpitPlugin=()=>{}").toString("base64") },
    { path: "assets/icon.png", mime: "image/png", content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(16).fill(0)]).toString("base64") },
    ...extraFiles,
  ]
  const bytes = Buffer.from(JSON.stringify({ archiveVersion: 1, files }))
  return { payload: Uint8Array.from(bytes).buffer, digest: createHash("sha256").update(bytes).digest("hex") }
}
const controllers = new Set<RuntimeFrameController>()
function fixture(execute: (request: PluginRequest, signal: AbortSignal) => Promise<JsonValue> = async () => null) {
  const frame = new Frame(), port1 = new Port(), port2 = new Port()
  const callbacks = { onReady: vi.fn(), onError: vi.fn(), onDispose: vi.fn() }
  const controller = createRuntimeFrame({ frame: frame as unknown as HTMLIFrameElement, ...makePayload(), context, execute, crypto: cryptoApi,
    createChannel: () => ({ port1, port2 }) as unknown as MessageChannel, ...callbacks })
  controllers.add(controller)
  return { frame, port1, port2, controller, ...callbacks }
}
async function connect(value: ReturnType<typeof fixture>) {
  value.frame.load()
  const [message, origin, ports] = value.frame.contentWindow.postMessage.mock.calls[0]
  expect(origin).toBe("*")
  expect(ports).toEqual([value.port2])
  value.port1.receive({ type: "cogpit-plugin-connected", nonce: message.nonce })
  await vi.waitFor(() => expect(value.port1.sent.some((message) => (message as { type: string }).type === "cogpit-plugin-load")).toBe(true))
}
const request = (id: string, method = "lifecycle.ready", params: unknown = {}) => ({ protocol: 1, type: "request", id, method, params })
afterEach(() => { for (const controller of controllers) controller.dispose(); controllers.clear(); vi.useRealTimers() })

describe("runtime frame controller", () => {
  it("finishes readiness when a project is cached before its handshake completes", async () => {
    let finish!: (value: JsonValue) => void
    let signal!: AbortSignal
    const value = fixture((_request, current) => { signal = current; return new Promise(resolve => { finish = resolve }) })
    await connect(value); value.port1.receive(request("ready"))
    value.controller.setActive(false)
    expect(signal.aborted).toBe(false)
    finish(null)
    await vi.waitFor(() => expect(value.onReady).toHaveBeenCalledOnce())
    expect(value.onError).not.toHaveBeenCalled()
    value.controller.setActive(true)
    expect(value.onReady).toHaveBeenCalledOnce()
  })
  it("binds a single port to the frame, sends only verified package bytes, and marks ready after host approval", async () => {
    const execute = vi.fn(async () => null)
    const value = fixture(execute)
    expect(value.frame.src).toBe(RUNTIME_SHELL_PATH)
    await connect(value)
    const load = value.port1.sent[0] as Record<string, unknown>
    expect(Object.keys(load).sort()).toEqual(["assets", "context", "entry", "style", "type"])
    expect(load.context).toEqual(context)
    value.port1.receive(request("r1"))
    await vi.waitFor(() => expect(value.onReady).toHaveBeenCalledOnce())
    expect(execute).toHaveBeenCalledOnce()
    expect(value.port1.sent).toContainEqual({ protocol: 1, type: "result", id: "r1", value: null })
  })
  it("rejects a forged nonce before delivering code", () => {
    const value = fixture(); value.frame.load()
    value.port1.receive({ type: "cogpit-plugin-connected", nonce: "forged" })
    expect(value.onError).toHaveBeenCalledOnce()
    expect(value.port1.sent.some((message) => (message as { type: string }).type === "cogpit-plugin-load")).toBe(false)
    expect(value.port1.closed).toBe(true)
  })
  it("revokes the frame and aborts outstanding work on reload", async () => {
    let signal: AbortSignal | undefined
    const value = fixture(async (_request, current) => { signal = current; return new Promise(() => {}) })
    await connect(value); value.port1.receive(request("r1", "storage.get", { key: "setting" }))
    expect(signal?.aborted).toBe(false)
    value.frame.load()
    expect(signal?.aborted).toBe(true)
    expect(value.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Plugin frame navigated or reloaded" }))
    expect(value.onDispose).toHaveBeenCalledOnce()
  })
  it("does not deliver bytes after disposal during integrity verification", async () => {
    const value = fixture(); value.frame.load(); value.controller.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(value.port1.sent.some((message) => (message as { type: string }).type === "cogpit-plugin-load")).toBe(false)
    expect(value.onDispose).toHaveBeenCalledOnce()
    expect(value.onError).not.toHaveBeenCalled()
  })
  it("cancels work and ignores an asynchronous result from a disposed activation", async () => {
    let resolve!: (value: JsonValue) => void
    let signal!: AbortSignal
    const value = fixture((_request, current) => { signal = current; return new Promise((done) => { resolve = done }) })
    await connect(value); value.port1.receive(request("r1", "storage.get", { key: "setting" }))
    value.controller.dispose(); resolve("late")
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(value.port1.sent.some((message) => (message as { type: string }).type === "result")).toBe(false)
  })
  it("revokes on project change and updates presentation through validated events", async () => {
    const value = fixture(); await connect(value)
    value.controller.updateContext({ ...context, theme: { mode: "light", tokens: {} } })
    expect(value.port1.sent).toContainEqual({ protocol: 1, type: "event", event: "theme", value: { mode: "light", tokens: {} } })
    value.controller.updateContext({ ...context, project: { id: "p2", name: "Other" } })
    expect(value.onDispose).toHaveBeenCalledOnce()
    expect(value.port1.closed).toBe(true)
  })
  it("suspends hidden panels and cancels in-flight requests", async () => {
    let signal!: AbortSignal
    const execute = vi.fn((_request: PluginRequest, current: AbortSignal) => { signal = current; return new Promise<JsonValue>(() => {}) })
    const value = fixture(execute); await connect(value)
    value.port1.receive(request("r1", "storage.get", { key: "setting" }))
    value.controller.setActive(false)
    expect(value.port1.sent).toContainEqual({ protocol: 1, type: "error", id: "r1", error: { code: "CANCELED", message: "Plugin request was canceled" } })
    expect(signal.aborted).toBe(true)
    value.port1.receive(request("r2", "storage.get", { key: "setting" }))
    expect(execute).toHaveBeenCalledOnce()
    expect(value.port1.sent).toContainEqual({ protocol: 1, type: "error", id: "r2", error: { code: "RATE_LIMITED", message: "Plugin panel is hidden" } })
  })
  it("cancels a request by ID without affecting another", async () => {
    const signals: AbortSignal[] = []
    const value = fixture(async (_request, signal) => { signals.push(signal); return new Promise(() => {}) }); await connect(value)
    value.port1.receive(request("r1", "storage.get", { key: "a" })); value.port1.receive(request("r2", "storage.get", { key: "b" }))
    value.port1.receive({ protocol: 1, type: "cancel", id: "r1" })
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
  })
  it("fails duplicate IDs, duplicate readiness and wrong message directions", async () => {
    const duplicate = fixture(async () => new Promise(() => {})); await connect(duplicate)
    duplicate.port1.receive(request("r1")); duplicate.port1.receive(request("r1"))
    expect(duplicate.onError).toHaveBeenCalledOnce()
    const ready = fixture(); await connect(ready)
    ready.port1.receive(request("r1")); await Promise.resolve(); ready.port1.receive(request("r2"))
    expect(ready.onError).toHaveBeenCalledOnce()
    const wrong = fixture(); await connect(wrong)
    wrong.port1.receive({ protocol: 1, type: "result", id: "r1", value: null })
    expect(wrong.onError).toHaveBeenCalledOnce()
  })
  it("caps outstanding requests and message frequency", async () => {
    const outstanding = fixture(async () => new Promise(() => {})); await connect(outstanding)
    for (let index = 0; index < 33; index++) outstanding.port1.receive(request(`r${index}`, "storage.get", { key: "setting" }))
    expect(outstanding.onError).toHaveBeenCalledOnce()
    const flood = fixture(); await connect(flood)
    for (let index = 0; index < 121; index++) flood.port1.receive({ protocol: 1, type: "cancel", id: `r${index}` })
    expect(flood.onError).toHaveBeenCalledOnce()
  })
  it("redacts execution errors and rejects credentials in message envelopes", async () => {
    const value = fixture(async () => { throw new Error("provider-secret-do-not-leak") }); await connect(value)
    value.port1.receive(request("r1", "storage.get", { key: "setting" }))
    await Promise.resolve()
    expect(JSON.stringify(value.port1.sent)).not.toContain("provider-secret")
    value.port1.receive({ ...request("r2"), activationLease: "fake" })
    expect(value.onError).toHaveBeenCalledOnce()
  })
  it("times out readiness ten seconds after delivery and handles script errors", async () => {
    vi.useFakeTimers()
    const timed = fixture(); await connect(timed)
    const remaining = 10000 - (Date.now() - timed.port1.sentAt[0])
    await vi.advanceTimersByTimeAsync(remaining - 1)
    expect(timed.onError).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(timed.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Plugin did not become ready within 10 seconds" }))
    vi.useRealTimers()
    const failed = fixture(); await connect(failed)
    failed.port1.receive({ type: "cogpit-plugin-load-error" })
    expect(failed.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Plugin entry failed to load" }))
  })
})

describe("verified browser package preparation", () => {
  async function prepareCss(css: string) {
    const fixture = makePayload([{ path: "dist/plugin.css", mime: "text/css", content: Buffer.from(css).toString("base64") }], { style: "dist/plugin.css" })
    return (await prepareRuntimePackage(fixture.payload, fixture.digest, cryptoApi)).style
  }
  it("fails integrity before trying to parse malformed JSON", async () => {
    await expect(prepareRuntimePackage(new TextEncoder().encode("not-json").buffer, "0".repeat(64), cryptoApi)).rejects.toThrow("integrity")
  })
  it("reports unavailable Web Crypto instead of skipping verification", async () => {
    const { payload, digest } = makePayload()
    await expect(prepareRuntimePackage(payload, digest, {} as Crypto)).rejects.toThrow("Web Crypto")
  })
  it("resolves local stylesheet raster references to package asset names", async () => {
    expect(await prepareCss('.logo{background:url("../assets/icon.png")}')).toBe('.logo{background:url("assets/icon.png")}')
  })
  it("preserves generated Tailwind selectors, support conditions and custom properties", async () => {
    const css = String.raw`@layer utilities{.hover\:bg-blue-500:hover{background:var(--color-blue-500)}.w-\[50\%\]{width:50%}}@supports ((-webkit-hyphens:none) and (not (margin-trim:inline))){*,::before,::after,::backdrop{--tw-rotate-x:initial}}@property --tw-rotate-x{syntax:"*";inherits:false;}`
    expect(await prepareCss(css)).toBe(css)
  })
  it.each([
    String.raw`.x{--logo:url(../assets/ic\6fn.png);background:var(--logo)}`,
    String.raw`.x{--logo:u\72l("../assets/ic\6fn.png");background:var(--logo)}`,
    String.raw`.x{--logo:URL( '../assets/icon.png' /* after */ );background:var(--logo)}`,
  ])("rewrites escaped and custom-property URL tokens in %s", async (css) => {
    expect(await prepareCss(css)).toBe('.x{--logo:url("assets/icon.png");background:var(--logo)}')
  })
  it("keeps URL-looking strings inert and never joins comment-separated identifiers", async () => {
    expect(await prepareCss(String.raw`.x{content:'url("missing.png")';background:u/**/rl("https://example.com/x.png")}/*! url("missing.png") */`))
      .toBe(String.raw`.x{content:"url(\"missing.png\")";background:u rl("https://example.com/x.png")} `)
    expect(await prepareCss('@im/**/port "https://example.com/x.css";')).toBe('@im port "https://example.com/x.css";')
  })
  it.each([
    '@import "https://example.com/style.css";', String.raw`@\69mport/**/"https://example.com/style.css";`,
    '@font-face{font-family:External;src:local("External")}', String.raw`@font\2d face{font-family:External;src:url("../assets/icon.png")}`,
    '.x{background:url(https://example.com/image.png)}', String.raw`.x{--logo:u\72l("https://example.com/image.png")}`,
    '.x{background:url(data:image/svg+xml,x)}', '.x{background:u\\rl(x)}', '.x{background:url(../../../outside.png)}',
    '.x{background:image-set("https://example.com/image.png" 1x)}', String.raw`.x{background:\69mage-set("https://example.com/image.png" 1x)}`,
    '.x{--logo:url("//example.com/image.png")}', String.raw`.x{background:url(https\3a //example.com/image.png)}`,
    '.x{background:url("../assets/icon.png" extra)}', '.x{background:url(/* before */ "../assets/icon.png")}', '.x{background:url(bad"url)}', '.x{content:"bad\nstring"}',
    '.x{content:"unfinished}', '.x{background:url(../assets/icon.png}', '.x{}/* unfinished',
  ])("rejects external or malformed stylesheet %s", async (css) => {
    await expect(prepareCss(css)).rejects.toThrow()
  })
  it("bounds stylesheet nesting and token counts before rewriting", async () => {
    await expect(prepareCss(`.x{width:${"calc(".repeat(129)}1px${")".repeat(129)}}`)).rejects.toThrow("nesting")
    await expect(prepareCss(".x{}".repeat(50_001))).rejects.toThrow("token limit")
  })
  it.each(["../asset.png", "C:/asset.png", "assets/CON.png", "assets/icon.png", "assets/ICON.png"])("rejects unsafe or colliding asset %s", async (path) => {
    const fixture = makePayload([{ path, mime: "image/png", content: "" }])
    await expect(prepareRuntimePackage(fixture.payload, fixture.digest, cryptoApi)).rejects.toThrow()
  })
  it("rejects extra scripts, executable HTML and malformed base64", async () => {
    for (const entry of [{ path: "extra.js", mime: "text/javascript", content: "" }, { path: "extra.html", mime: "text/html", content: "" }, { path: "extra.txt", mime: "text/plain", content: "AB==" }]) {
      const fixture = makePayload([entry])
      await expect(prepareRuntimePackage(fixture.payload, fixture.digest, cryptoApi)).rejects.toThrow()
    }
  })
})
