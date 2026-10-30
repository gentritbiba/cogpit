import { readJsonBody, sendJson, type UseFn } from "../http"
import { getPluginManager, type PluginManager } from "../plugins/manager"
import { PluginAuthorizationError } from "../plugins/authorization"

/**
 * Speech for clients that cannot host plugin frames (the iOS app's voice mode and
 * speech cards): synthesizes text through the Text to speech plugin's connection,
 * voice and settings.
 *
 *   POST /api/voice/speech  { text } → audio bytes, voice name in X-Cogpit-Voice
 */
const PLUGIN = "cogpit.tts"
const CONNECTION = "speech"
const MAX_TEXT = 16384

interface VoiceDependencies { manager: () => PluginManager | null }

function failure(error: unknown): [number, string, string] {
  if (error instanceof PluginAuthorizationError) return [error.status, error.code, error.message]
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined
  if (code === "CONNECTION_REQUIRED" || code === "RESOURCE_REQUIRED" || code === "STALE_ACTIVATION" || code === "PERMISSION_REQUIRED")
    return [503, "voice_not_configured", "Set up Text to speech in Plugins to use the Cogpit voice"]
  if (code === "RATE_LIMITED") return [429, "voice_rate_limited", "Too many speech requests; try again shortly"]
  if (code === "INVALID_REQUEST") return [400, "voice_invalid_request", "The speech service rejected this text"]
  return [502, "voice_failed", "The speech service did not answer"]
}

function speedAndFormat(values: Record<string, unknown>): { speed: number; format: string } {
  return {
    speed: typeof values.speed === "number" ? values.speed : 1,
    format: values.format === "wav" ? "wav" : "mp3",
  }
}

export function registerVoiceRoutes(use: UseFn, dependencies: VoiceDependencies = { manager: getPluginManager }): void {
  use("/api/voice/speech", async (req, res, next) => {
    if (req.method !== "POST") return next()
    const body = await readJsonBody(req).catch(() => null) as { text?: unknown } | null
    const text = typeof body?.text === "string" ? body.text.trim() : ""
    if (!text || text.length > MAX_TEXT) return sendJson(res, 400, { code: "voice_invalid_request", error: `Send between 1 and ${MAX_TEXT} characters of text` })
    const manager = dependencies.manager()
    if (!manager) return sendJson(res, 503, { code: "voice_not_configured", error: "Plugin host is unavailable" })

    const abort = new AbortController()
    const disconnected = () => { if (!res.writableEnded) abort.abort() }
    req.once("aborted", disconnected); res.once("close", disconnected)
    try {
      const { audio, voice } = await manager.withLegacyPlugin(req, { pluginId: PLUGIN, signal: abort.signal }, async (caller) => {
        const target = { pluginId: PLUGIN, projectId: caller.projectId }
        const [settings, connections] = await Promise.all([
          manager.settings(caller.request, target, caller.options),
          manager.listConnections(caller.request, target, caller.options),
        ])
        const voice = connections.connections.find(connection => connection.id === CONNECTION)?.selected.voice?.label ?? null
        return { audio: await caller.media(CONNECTION, "synthesize", { input: text, ...speedAndFormat(settings.values) }), voice }
      })
      if (abort.signal.aborted) return
      const bytes = Buffer.from(audio.bytes)
      res.writeHead(200, {
        "Content-Type": audio.mimeType,
        "Content-Length": bytes.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        ...voice ? { "X-Cogpit-Voice": encodeURIComponent(voice) } : {},
      })
      res.end(bytes)
    } catch (error) {
      if (abort.signal.aborted) return
      const [status, code, message] = failure(error)
      sendJson(res, status, { code, error: message })
    } finally {
      req.removeListener("aborted", disconnected); res.removeListener("close", disconnected)
    }
  })
}
