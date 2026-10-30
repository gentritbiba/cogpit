// @vitest-environment node
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { Middleware } from "../../http"
import type { PluginManager } from "../../plugins/manager"
import { PluginDataError } from "../../plugins/privateStore"
import { registerVoiceRoutes } from "../../routes/voice"
import { asIncomingMessage, asServerResponse, collectRoutes, getRouteHandler } from "../http-fixtures"

const audio = { mimeType: "audio/mpeg", bytes: new Uint8Array([1, 2, 3]) }

function fakeManager(options: { media?: () => Promise<typeof audio>; dictate?: () => Promise<{ text: string }>; voice?: string | null; settings?: Record<string, unknown> } = {}) {
  const media = vi.fn(options.media ?? (async () => audio))
  const dictate = vi.fn(options.dictate ?? (async () => ({ text: "run the tests" })))
  const manager = {
    withLegacyPlugin: vi.fn(async (_req: unknown, _input: unknown, run: (caller: unknown) => Promise<unknown>) =>
      run({ request: {}, projectId: null, projectPath: null, options: {}, call: vi.fn(), media, dictate })),
    settings: vi.fn(async () => ({ values: options.settings ?? { speed: 1.2, format: "mp3" }, revision: 1 })),
    listConnections: vi.fn(async () => ({
      revision: 1,
      connections: [{ id: "speech", selected: options.voice === null ? {} : { voice: { id: "af_heart", label: options.voice ?? "Heart" } } }],
    })),
  }
  return { manager: manager as unknown as PluginManager, media, dictate, withLegacyPlugin: manager.withLegacyPlugin }
}

async function post(handler: Middleware, body: unknown, contentType?: string) {
  let data: unknown = ""
  let head: { status: number; headers: Record<string, unknown> } | null = null
  const res = asServerResponse(Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: false,
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: (status: number, headers: Record<string, unknown>) => { head = { status, headers } },
    end: (value?: unknown) => { data = value ?? "" },
  }))
  const chunk = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const req = asIncomingMessage(Object.assign(new EventEmitter(), {
    method: "POST", url: "/", headers: contentType ? { "content-type": contentType } : {},
    async *[Symbol.asyncIterator]() { yield chunk },
  }))
  const done = handler(req, res, vi.fn())
  req.emit("data", chunk)
  req.emit("end")
  await done
  return head
    ? { status: (head as { status: number }).status, headers: (head as { headers: Record<string, unknown> }).headers, data }
    : { status: res.statusCode, headers: {}, data: JSON.parse(String(data)) }
}

function handlerFor(manager: PluginManager | null, path = "/api/voice/speech") {
  return getRouteHandler(collectRoutes(use => registerVoiceRoutes(use, { manager: () => manager })), path)
}

describe("POST /api/voice/speech", () => {
  it("synthesizes through the Text to speech plugin with its voice and settings", async () => {
    const { manager, media, withLegacyPlugin } = fakeManager({ voice: "Heart" })
    const response = await post(handlerFor(manager), { text: "  The build passed.  " })

    expect(withLegacyPlugin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pluginId: "cogpit.tts" }), expect.any(Function))
    expect(media).toHaveBeenCalledWith("speech", "synthesize", { input: "The build passed.", speed: 1.2, format: "mp3" })
    expect(response.status).toBe(200)
    expect(response.headers).toMatchObject({ "Content-Type": "audio/mpeg", "Content-Length": 3, "X-Cogpit-Voice": "Heart" })
    expect([...(response.data as Buffer)]).toEqual([1, 2, 3])
  })

  it("falls back to default speed and format when settings are missing", async () => {
    const { manager, media } = fakeManager({ settings: {} })
    await post(handlerFor(manager), { text: "Hello" })
    expect(media).toHaveBeenCalledWith("speech", "synthesize", { input: "Hello", speed: 1, format: "mp3" })
  })

  it("rejects empty and oversized text before reaching the plugin", async () => {
    const { manager, withLegacyPlugin } = fakeManager()
    expect((await post(handlerFor(manager), { text: "   " })).status).toBe(400)
    expect((await post(handlerFor(manager), { text: "a".repeat(16385) })).status).toBe(400)
    expect(withLegacyPlugin).not.toHaveBeenCalled()
  })

  it("reports an unconfigured voice so the client can use its own", async () => {
    const { manager } = fakeManager({ media: async () => { throw new PluginDataError("CONNECTION_REQUIRED", "Configure this connection") } })
    expect(await post(handlerFor(manager), { text: "Hello" })).toMatchObject({ status: 503, data: { code: "voice_not_configured" } })
    expect(await post(handlerFor(null), { text: "Hello" })).toMatchObject({ status: 503, data: { code: "voice_not_configured" } })
  })

  it("reports a failing speech service as a bad gateway", async () => {
    const { manager } = fakeManager({ media: async () => { throw new PluginDataError("UPSTREAM_FAILED", "boom") } })
    expect(await post(handlerFor(manager), { text: "Hello" })).toMatchObject({ status: 502, data: { code: "voice_failed" } })
  })
})

describe("POST /api/voice/transcribe", () => {
  const wav = Buffer.from("RIFF....WAVEfmt ")

  it("transcribes a recording through the plugin's dictation", async () => {
    const { manager, dictate, withLegacyPlugin } = fakeManager()
    const response = await post(handlerFor(manager, "/api/voice/transcribe"), wav, "audio/wav")
    expect(withLegacyPlugin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pluginId: "cogpit.tts" }), expect.any(Function))
    expect(dictate).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "audio/wav" }))
    expect(response).toMatchObject({ status: 200, data: { text: "run the tests" } })
  })

  it("refuses a body that is not audio before reaching the plugin", async () => {
    const { manager, dictate } = fakeManager()
    expect((await post(handlerFor(manager, "/api/voice/transcribe"), wav, "text/plain")).status).toBe(400)
    expect(dictate).not.toHaveBeenCalled()
  })

  it("reports a plugin without dictation as not configured", async () => {
    const { manager } = fakeManager({ dictate: async () => { throw new PluginDataError("PERMISSION_REQUIRED", "This plugin does not provide dictation") } })
    expect(await post(handlerFor(manager, "/api/voice/transcribe"), wav, "audio/wav")).toMatchObject({ status: 503, data: { code: "voice_not_configured" } })
  })
})
