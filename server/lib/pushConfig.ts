import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Push notification config, read from ~/.cogpit/push.json with environment
 * overrides so a headless box can be configured entirely through systemd.
 *
 * Deliberately not part of AppConfig: the topic is a bearer secret — anyone who
 * knows it can read every notification — so it must never reach the renderer or
 * an API response.
 */
export interface PushConfig {
  /** ntfy base URL. JSON publishing posts to the root, never to /<topic>. */
  ntfyUrl: string
  topic: string
  token?: string
  /** Reachable base URL used to build notification click targets. */
  publicUrl?: string
}

export const PUSH_CONFIG_FILE = join(homedir(), ".cogpit", "push.json")

const DEFAULT_NTFY_URL = "https://ntfy.sh"
/** ntfy's topic charset. A topic outside it silently never delivers. */
const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/

interface Cache {
  key: string
  config: PushConfig | null
}

let cache: Cache | null = null
let lastWarning = ""

function warnOnce(message: string): void {
  if (lastWarning === message) return
  lastWarning = message
  console.error(`[push] ${message}`)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

function readConfigFile(path: string): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    // An absent file is the normal unconfigured case. Anything else — bad
    // permissions, most likely — would otherwise be indistinguishable from
    // "push not set up", and push would just never fire with no explanation.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") warnOnce(`Could not read ${path}: ${code ?? String(err)}`)
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      warnOnce(`${path} must contain a JSON object`)
      return {}
    }
    return parsed as Record<string, unknown>
  } catch {
    warnOnce(`${path} is not valid JSON`)
    return {}
  }
}

function normalizeBaseUrl(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    warnOnce(`Ignoring ${label} "${value}": not a valid URL`)
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warnOnce(`Ignoring ${label} "${value}": only http and https are supported`)
    return undefined
  }
  return parsed.toString().replace(/\/+$/, "")
}

function resolve(path: string): PushConfig | null {
  const file = readConfigFile(path)

  const topic = asString(process.env.COGPIT_NTFY_TOPIC) ?? asString(file.topic)
  if (!topic) return null
  if (!TOPIC_PATTERN.test(topic)) {
    // Never log the value: a rejected topic is usually a typo of the real one,
    // and the topic is a bearer secret.
    warnOnce("Ignoring ntfy topic: must match [-_A-Za-z0-9] and be at most 64 chars")
    return null
  }

  return {
    ntfyUrl:
      normalizeBaseUrl(asString(process.env.COGPIT_NTFY_URL) ?? asString(file.ntfyUrl), "ntfyUrl") ??
      DEFAULT_NTFY_URL,
    topic,
    token: asString(process.env.COGPIT_NTFY_TOKEN) ?? asString(file.token),
    publicUrl: normalizeBaseUrl(
      asString(process.env.COGPIT_PUBLIC_URL) ?? asString(file.publicUrl),
      "publicUrl",
    ),
  }
}

/**
 * Resolve push config, or null when push is not set up. Re-reads when the file
 * or the relevant environment changes, so edits take effect without a restart.
 */
export function getPushConfig(path = PUSH_CONFIG_FILE): PushConfig | null {
  const key = [
    path,
    fileMtime(path),
    process.env.COGPIT_NTFY_TOPIC,
    process.env.COGPIT_NTFY_URL,
    process.env.COGPIT_NTFY_TOKEN,
    process.env.COGPIT_PUBLIC_URL,
  ].join("\u0000")

  if (cache?.key === key) return cache.config

  const config = resolve(path)
  cache = { key, config }
  return config
}

/** Test seam: forget the cache and the one-shot warning. */
export function resetPushConfigCache(): void {
  cache = null
  lastWarning = ""
}
