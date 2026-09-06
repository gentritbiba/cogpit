// Browser-safe viewer protocol: JSON messages on the /__browser socket. Frames
// travel as binary alongside these, see ./frames.ts.

export type BrowserClientMessage =
  | { type: "viewport"; width: number; height: number; dpr: number }
  | { type: "mouse"; event: "move" | "down" | "up"; x: number; y: number; button: "left" | "middle" | "right" | "none"; clickCount: number; modifiers: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { type: "key"; event: "down" | "up"; key: string; code: string; text?: string; modifiers: number }
  | { type: "navigate"; url: string }
  | { type: "back" } | { type: "forward" } | { type: "reload" }
  | { type: "follow"; targetId: string }
  | { type: "launch"; url: string }

export interface BrowserTab { targetId: string; url: string; title: string }

export type BrowserServerMessage =
  | { type: "status"; state: "not-installed" | "stopped" | "connecting" | "live"; session: string; message?: string }
  | { type: "tabs"; tabs: BrowserTab[]; followed: string | null }
  | { type: "page"; targetId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean }
  | { type: "error"; message: string }

const MAX_VIEWPORT_PX = 8192
const MAX_DPR = 4
/** Cap on any url the server is asked to open, from the socket or the REST route. */
export const MAX_URL_LENGTH = 2048

type FieldCheck = (value: unknown) => boolean

const finite: FieldCheck = (value) => typeof value === "number" && Number.isFinite(value)
const count: FieldCheck = (value) => Number.isInteger(value) && (value as number) >= 0
const string: FieldCheck = (value) => typeof value === "string"
const optional = (check: FieldCheck): FieldCheck => (value) => value === undefined || check(value)
const oneOf = (allowed: readonly string[]): FieldCheck => (value) => string(value) && allowed.includes(value as string)
const within = (max: number): FieldCheck => (value) => finite(value) && (value as number) > 0 && (value as number) <= max
const url: FieldCheck = (value) => string(value) && (value as string).length > 0 && (value as string).length <= MAX_URL_LENGTH

type ClientMessageType = BrowserClientMessage["type"]
type ClientMessageOf<T extends ClientMessageType> = Extract<BrowserClientMessage, { type: T }>
type FieldChecks<M> = { [K in Exclude<keyof M, "type">]-?: FieldCheck }

/** One check per field of every variant; adding a field to the union without a check fails to compile. */
const CLIENT_MESSAGE_FIELDS: { [T in ClientMessageType]: FieldChecks<ClientMessageOf<T>> } = {
  viewport: { width: within(MAX_VIEWPORT_PX), height: within(MAX_VIEWPORT_PX), dpr: within(MAX_DPR) },
  mouse: { event: oneOf(["move", "down", "up"]), x: finite, y: finite, button: oneOf(["left", "middle", "right", "none"]), clickCount: count, modifiers: count },
  wheel: { x: finite, y: finite, deltaX: finite, deltaY: finite, modifiers: count },
  key: { event: oneOf(["down", "up"]), key: string, code: string, text: optional(string), modifiers: count },
  navigate: { url },
  back: {},
  forward: {},
  reload: {},
  follow: { targetId: string },
  launch: { url },
}

/**
 * The server's only validation of viewer input: anything not in the table, or
 * failing its check, is dropped. Unknown fields never reach the caller.
 */
export function parseClientMessage(raw: string): BrowserClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const candidate = parsed as Record<string, unknown>
  const type = candidate.type
  if (typeof type !== "string" || !Object.hasOwn(CLIENT_MESSAGE_FIELDS, type)) return null

  const message: Record<string, unknown> = { type }
  for (const [field, check] of Object.entries<FieldCheck>(CLIENT_MESSAGE_FIELDS[type as ClientMessageType])) {
    const value = candidate[field]
    if (!check(value)) return null
    if (value !== undefined) message[field] = value
  }
  return message as BrowserClientMessage
}
