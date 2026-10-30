// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Composer envelope v1: the typed context a message carries beside the text
 * its author typed, and the one readable form every agent receives.
 *
 * A message with context is sent as text: one `<context …>` block per item,
 * in order, then a blank line and the typed text. That is what the native
 * transcript records, what an older or external reader shows, and what this
 * module parses back into the same items when history, a queued message or a
 * pasted copy is read again — so the envelope needs no store of its own.
 * Images travel as the message's ordinary image attachments; a browser
 * capture names the one it saved by position.
 */

export type ComposerContextKind = "file" | "terminal" | "quote" | "browser"

interface ContextBase {
  /** Stable across drafts, sends, history and copies: `ctx-` and 8–32 letters or digits. */
  id: string
}

/** A project file, whole or as a line range, optionally with a review comment. */
export interface FileContext extends ContextBase {
  kind: "file"
  path: string
  startLine?: number
  endLine?: number
  /** The saved excerpt; absent for a reference to the whole file. */
  text?: string
  comment?: string
}

/** Text selected in a terminal. */
export interface TerminalContext extends ContextBase {
  kind: "terminal"
  text: string
  /** The terminal it came from, as its tab names it. */
  label?: string
}

/** Where a quoted reply came from: the session by transcript address, the turn by its parser id. */
export interface QuoteSource {
  dirName: string
  fileName: string
  sessionId: string
  turnId: string
}

/** Part of an assistant's reply, saved as it read when quoted. */
export interface QuoteContext extends ContextBase {
  kind: "quote"
  text: string
  source: QuoteSource
}

/** A frozen browser frame region with a note; the region's image is attached. */
export interface BrowserContext extends ContextBase {
  kind: "browser"
  note: string
  url: string
  title: string
  /** The page's CSS pixel size when the frame was captured. */
  viewport: { width: number; height: number }
  /** The annotated region, in page CSS pixels. */
  region: { x: number; y: number; width: number; height: number }
  capturedAt: string
  /** The browser and tab it came from, as the Browser panel names them. */
  browser: string
  tab?: string
  /** 1-based position of the saved image among the message's attachments. */
  image: number
}

export type ComposerContextItem = FileContext | TerminalContext | QuoteContext | BrowserContext

/** An image a draft holds: bytes, never a `File` or object URL, so a draft can be saved and restored. */
export interface ComposerAttachment {
  id: string
  mediaType: string
  /** Base64 bytes. */
  data: string
  /** The context item whose capture this is; absent for an image the author attached. */
  contextId?: string
}

/** Everything a composer holds for one message. */
export interface ComposerDraft {
  v: 1
  text: string
  context: ComposerContextItem[]
  attachments: ComposerAttachment[]
}

export const EMPTY_DRAFT: ComposerDraft = Object.freeze({ v: 1, text: "", context: [], attachments: [] }) as ComposerDraft

/**
 * Bounds a draft's context: more would crowd out the conversation. A body
 * (with a review comment) is bounded by `itemChars`, every other field by
 * `metadataChars`, and everything the message carries for its context — as
 * serialized, escaping included — by `totalChars`.
 */
export const CONTEXT_LIMITS = Object.freeze({ items: 12, itemChars: 20_000, metadataChars: 2_000, totalChars: 100_000, noteChars: 2_000 })

const ID_RE = /^ctx-[a-z0-9]{8,32}$/

export function newContextId(random: () => string = () => crypto.randomUUID()): string {
  return `ctx-${random().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16)}`
}

export function isDraftEmpty(draft: ComposerDraft): boolean {
  return !draft.text.trim() && draft.context.length === 0 && draft.attachments.length === 0
}

/** The item's text, cut to the per-item bound; `cut` counts what was left out. */
export function boundContextText(text: string): { text: string; cut: number } {
  return text.length <= CONTEXT_LIMITS.itemChars ? { text, cut: 0 } : { text: text.slice(0, CONTEXT_LIMITS.itemChars), cut: text.length - CONTEXT_LIMITS.itemChars }
}

function itemChars(item: ComposerContextItem): number {
  return item.kind === "browser" ? item.note.length : item.kind === "file" ? (item.text?.length ?? 0) + (item.comment?.length ?? 0) : item.text.length
}

/** Why one item is out of bounds on its own, or null. */
function itemRefusal(item: ComposerContextItem): string | null {
  if (!ID_RE.test(item.id)) return "This context has no valid id"
  if (itemChars(item) > CONTEXT_LIMITS.itemChars) return `This context is longer than ${CONTEXT_LIMITS.itemChars.toLocaleString("en-US")} characters`
  if (item.kind === "browser" && item.note.length > CONTEXT_LIMITS.noteChars) return `An annotation note is limited to ${CONTEXT_LIMITS.noteChars.toLocaleString("en-US")} characters`
  const metadata = attributes(item).filter(([key]) => key !== "comment")
  if (metadata.some(([, value]) => value.length > CONTEXT_LIMITS.metadataChars)) return `This context's ${metadata.find(([, value]) => value.length > CONTEXT_LIMITS.metadataChars)![0]} is longer than ${CONTEXT_LIMITS.metadataChars.toLocaleString("en-US")} characters`
  return null
}

/** Why `item` cannot join `context`, or null when it fits. */
export function contextRefusal(context: readonly ComposerContextItem[], item: ComposerContextItem): string | null {
  if (context.some((existing) => existing.id === item.id)) return null
  if (context.length >= CONTEXT_LIMITS.items) return `A message holds at most ${CONTEXT_LIMITS.items} context items`
  const refusal = itemRefusal(item)
  if (refusal) return refusal
  const total = [...context, item].reduce((sum, existing) => sum + renderContextItem(existing).length, 0)
  if (total > CONTEXT_LIMITS.totalChars) return `The message's context would exceed ${CONTEXT_LIMITS.totalChars.toLocaleString("en-US")} characters`
  return null
}

/** Why a whole list of context — restored, imported or about to be sent — is out of bounds, or null. */
export function validateContext(context: readonly ComposerContextItem[]): string | null {
  const accepted: ComposerContextItem[] = []
  for (const item of context) {
    if (accepted.some((existing) => existing.id === item.id)) return "The same context appears twice"
    const refusal = contextRefusal(accepted, item)
    if (refusal) return refusal
    accepted.push(item)
  }
  return null
}

/** A short name for an item, as its chip shows it. */
export function contextLabel(item: ComposerContextItem): string {
  switch (item.kind) {
    case "file": {
      const name = item.path.split("/").pop() || item.path
      if (item.startLine === undefined) return name
      return item.startLine === item.endLine || item.endLine === undefined ? `${name}:${item.startLine}` : `${name}:${item.startLine}-${item.endLine}`
    }
    case "terminal": return item.label ? `Terminal · ${item.label}` : "Terminal selection"
    case "quote": return `Quote · ${oneLine(item.text, 40)}`
    case "browser": return `Browser · ${item.title || item.url}`
  }
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ── The readable form ───────────────────────────────────────────────────────

/** Reversible: a multiline review comment reads back with its line breaks. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\r/g, "&#13;").replace(/\n/g, "&#10;")
}
function unescapeAttribute(value: string): string {
  return value.replace(/&#10;/g, "\n").replace(/&#13;/g, "\r").replace(/&lt;/g, "<").replace(/&quot;/g, "\"").replace(/&amp;/g, "&")
}
const CLOSE = "</context>"
/** A body line that would close the block early is indented by one space, and read back without it. */
function escapeBody(text: string): string {
  return text.split("\n").map((line) => /^ *<\/context>/.test(line) ? ` ${line}` : line).join("\n")
}
function unescapeBody(text: string): string {
  return text.split("\n").map((line) => /^ +<\/context>/.test(line) ? line.slice(1) : line).join("\n")
}

function attributes(item: ComposerContextItem): Array<[string, string]> {
  switch (item.kind) {
    case "file": return [
      ["path", item.path],
      ...(item.startLine !== undefined ? [["lines", item.endLine !== undefined && item.endLine !== item.startLine ? `${item.startLine}-${item.endLine}` : String(item.startLine)] as [string, string]] : []),
      ...(item.comment ? [["comment", item.comment] as [string, string]] : []),
    ]
    case "terminal": return item.label ? [["label", item.label]] : []
    case "quote": return [["session", item.source.sessionId], ["turn", item.source.turnId], ["dir", item.source.dirName], ["file", item.source.fileName]]
    case "browser": return [
      ["url", item.url], ["title", item.title], ["viewport", `${item.viewport.width}x${item.viewport.height}`],
      ["region", `${item.region.x},${item.region.y},${item.region.width},${item.region.height}`],
      ["captured", item.capturedAt], ["browser", item.browser], ...(item.tab ? [["tab", item.tab] as [string, string]] : []), ["image", String(item.image)],
    ]
  }
}

function body(item: ComposerContextItem): string {
  return item.kind === "browser" ? item.note : item.kind === "file" ? item.text ?? "" : item.text
}

export function renderContextItem(item: ComposerContextItem): string {
  const attrs = [["id", item.id], ["kind", item.kind], ...attributes(item)].map(([key, value]) => `${key}="${escapeAttribute(value!)}"`).join(" ")
  return `<context ${attrs}>\n${escapeBody(body(item))}\n${CLOSE}`
}

/**
 * The message text every agent receives for a draft: its context blocks in
 * order, then its text. A draft without context is its text, unchanged.
 */
export function renderComposerMessage(draft: Pick<ComposerDraft, "text" | "context">): string {
  const text = draft.text.trim()
  if (draft.context.length === 0) return text
  const blocks = draft.context.map(renderContextItem).join("\n\n")
  return text ? `${blocks}\n\n${text}` : blocks
}

const OPEN_RE = /^<context ((?:[a-z]+="[^"]*"\s*)+)>\n/

function parseAttributes(source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of source.matchAll(/([a-z]+)="([^"]*)"/g)) found.set(match[1]!, unescapeAttribute(match[2]!))
  return found
}

function positive(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  return Number(value)
}

function itemFrom(attrs: Map<string, string>, text: string): ComposerContextItem | null {
  const id = attrs.get("id")
  if (!id || !ID_RE.test(id)) return null
  switch (attrs.get("kind")) {
    case "file": {
      const path = attrs.get("path")
      if (!path) return null
      const [start, end] = (attrs.get("lines") ?? "").split("-")
      const startLine = positive(start)
      const endLine = positive(end) ?? startLine
      const comment = attrs.get("comment")
      return { id, kind: "file", path, ...(startLine !== undefined ? { startLine, endLine } : {}), ...(text ? { text } : {}), ...(comment ? { comment } : {}) }
    }
    case "terminal": {
      const label = attrs.get("label")
      return { id, kind: "terminal", text, ...(label ? { label } : {}) }
    }
    case "quote": {
      const [sessionId, turnId, dirName, fileName] = ["session", "turn", "dir", "file"].map((key) => attrs.get(key))
      if (!sessionId || !turnId || !dirName || !fileName) return null
      return { id, kind: "quote", text, source: { sessionId, turnId, dirName, fileName } }
    }
    case "browser": {
      const viewport = (attrs.get("viewport") ?? "").split("x").map(Number)
      const region = (attrs.get("region") ?? "").split(",").map(Number)
      const image = positive(attrs.get("image"))
      if (viewport.length !== 2 || region.length !== 4 || ![...viewport, ...region].every(Number.isFinite) || !image) return null
      const tab = attrs.get("tab")
      return {
        id, kind: "browser", note: text, url: attrs.get("url") ?? "", title: attrs.get("title") ?? "",
        viewport: { width: viewport[0]!, height: viewport[1]! }, region: { x: region[0]!, y: region[1]!, width: region[2]!, height: region[3]! },
        capturedAt: attrs.get("captured") ?? "", browser: attrs.get("browser") ?? "", ...(tab ? { tab } : {}), image,
      }
    }
    default: return null
  }
}

/**
 * The context and typed text of a message `renderComposerMessage` wrote, or
 * null for any other text. Only blocks that open the message count, so a
 * message that merely mentions a context tag reads as plain text.
 */
export function parseComposerMessage(message: string): { context: ComposerContextItem[]; text: string } | null {
  const context: ComposerContextItem[] = []
  let rest = message
  for (;;) {
    const open = OPEN_RE.exec(rest)
    if (!open) break
    const end = rest.indexOf(`\n${CLOSE}`, open[0].length - 1)
    if (end < 0) break
    const item = itemFrom(parseAttributes(open[1]!), unescapeBody(rest.slice(open[0].length, end)))
    if (!item) break
    context.push(item)
    rest = rest.slice(end + CLOSE.length + 1).replace(/^\n{1,2}/, "")
  }
  // Text that merely looks like an envelope, past the bounds a composer could have written, stays plain text.
  if (context.length === 0 || validateContext(context)) return null
  return { context, text: rest.trim() }
}

/** What the author typed, without the context blocks: for titles, previews and search snippets. */
export function composerPromptText(message: string): string {
  return parseComposerMessage(message)?.text ?? message
}
