/**
 * The assets an agent's reply shares, read from its markdown the way the
 * timeline renders it: images and videos (`![alt](path)`, or a bare media
 * path alone on a line), web links, links to local documents, and stored
 * views (a ```cogpit-view block holding `<id>@<n>`). Code blocks and inline
 * code are never read, and a link with a line number is a code reference,
 * not an asset.
 */
import { IMAGE_TYPES, VIDEO_TYPES } from "../mediaTypes"
import { parseViewReference } from "../views/stored"
import type { LibraryItemKind } from "./types"

export interface SharedAsset {
  kind: LibraryItemKind
  /** A link's URL, a file's absolute path, or a view's id. */
  target: string
  label: string | null
}

/** Local files worth keeping besides media: documents, data exports and archives. */
const DOCUMENT_EXTENSIONS = new Set([
  ".html", ".htm", ".pdf", ".md", ".markdown", ".mdx", ".txt", ".rtf", ".csv", ".tsv", ".log",
  ".xlsx", ".xls", ".ods", ".docx", ".doc", ".odt", ".pptx", ".ppt", ".odp", ".key", ".numbers", ".pages",
  ".zip", ".tar", ".gz", ".tgz", ".7z", ".dmg", ".ipynb", ".epub", ".excalidraw", ".drawio",
])

const MEDIA_EXTENSIONS = [...Object.keys(IMAGE_TYPES), ...Object.keys(VIDEO_TYPES)].map((extension) => extension.slice(1))

/** Strings a block must hold to share anything; the caller may skip one without any. */
export const ASSET_HINTS: readonly string[] = ["](", "]:", "://", "cogpit-view", ...MEDIA_EXTENSIONS.map((extension) => `.${extension}`)]

const MAX_LABEL = 200
const FENCE = /^[ \t>]*(`{3,}|~{3,})(.*)$/
const BARE_MEDIA_PATH = new RegExp(`^[ \\t]*((?:\\/|[a-z]:[\\\\/])\\S+\\.(?:${MEDIA_EXTENSIONS.join("|")}))[ \\t]*$`, "i")
const REFERENCE_DEFINITION = /^[ \t>]*\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?/
const BARE_URL = /https?:\/\/[^\s<>`"]+/gi
const TRAILING_PUNCTUATION = /[.,:;!?*_~'"\]]+$/
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i
/** Dev servers on this computer: they are gone by the time anyone opens the library. */
const LOOPBACK_URL = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1?\])(?:[:/?#]|$)/i
const LINE_REFERENCE = /(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/i

export function extractAssets(markdown: string): SharedAsset[] {
  const found = new Map<string, SharedAsset>()
  const add = (asset: SharedAsset | null) => {
    if (!asset) return
    const key = `${asset.kind}\u001f${asset.target}`
    const known = found.get(key)
    if (!known) found.set(key, asset)
    else if (!known.label && asset.label) known.label = asset.label
  }

  let fence: { marker: string; view: boolean; body: string[] } | null = null
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = FENCE.exec(line)
      if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.marker.length && !close[2]!.trim()) {
        if (fence.view) {
          const reference = parseViewReference(fence.body.join("\n"))
          if (reference) add({ kind: "view", target: reference.id, label: null })
        }
        fence = null
      } else if (fence.view) {
        fence.body.push(line)
      }
      continue
    }
    const open = FENCE.exec(line)
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { marker: open[1]!, view: open[2]!.trim().split(/\s+/)[0] === "cogpit-view", body: [] }
      continue
    }
    readLine(blankCodeSpans(line), line, add)
  }
  return [...found.values()]
}

/** `line` has its code spans blanked out; `original` is the same line as written, for labels. */
function readLine(line: string, original: string, add: (asset: SharedAsset | null) => void): void {
  const definition = REFERENCE_DEFINITION.exec(line)
  if (definition) {
    add(classify(definition[2]!, definition[1]!))
    return
  }
  const media = BARE_MEDIA_PATH.exec(line)
  if (media) {
    add(classify(media[1]!, null))
    return
  }
  const rest = readLinks(line, original, add)
  for (const match of rest.matchAll(BARE_URL)) add(classify(trimUrl(match[0]), null))
}

/** Reports every inline link and image, and returns the line with them blanked out for the bare-URL pass. */
function readLinks(line: string, original: string, add: (asset: SharedAsset | null) => void): string {
  const masked = line.split("")
  let index = 0
  while (index < line.length) {
    const char = line[index]
    if (char === "\\") {
      index += 2
      continue
    }
    if (char !== "[") {
      index++
      continue
    }
    const link = readLink(line, index)
    if (!link) {
      index++
      continue
    }
    const image = index > 0 && line[index - 1] === "!" && line[index - 2] !== "\\"
    const text = original.slice(index + 1, link.textEnd)
    add(classify(link.destination, text))
    // A linked image (`[![alt](src)](href)`) shares both.
    readLinks(line.slice(index + 1, link.textEnd), text, add)
    for (let position = image ? index - 1 : index; position < link.end; position++) masked[position] = " "
    index = link.end
  }
  return masked.join("")
}

interface InlineLink {
  /** Index of the closing bracket of the link text. */
  textEnd: number
  destination: string
  /** Index just past the closing parenthesis. */
  end: number
}

function readLink(line: string, start: number): InlineLink | null {
  let depth = 0
  let close = -1
  for (let index = start; index < line.length; index++) {
    const char = line[index]
    if (char === "\\") {
      index++
      continue
    }
    if (char === "[") depth++
    else if (char === "]" && --depth === 0) {
      close = index
      break
    }
  }
  if (close === -1 || line[close + 1] !== "(") return null

  let position = close + 2
  while (line[position] === " ") position++
  let destination: string
  if (line[position] === "<") {
    const end = line.indexOf(">", position)
    if (end === -1) return null
    destination = line.slice(position + 1, end)
    position = end + 1
  } else {
    const from = position
    let parens = 0
    while (position < line.length) {
      const char = line[position]!
      if (char === "\\") {
        position += 2
        continue
      }
      if (/\s/.test(char)) break
      if (char === "(") parens++
      else if (char === ")") {
        if (parens === 0) break
        parens--
      }
      position++
    }
    destination = line.slice(from, position)
  }
  while (line[position] === " ") position++
  const quote = line[position]
  if (quote === "\"" || quote === "'" || quote === "(") {
    const end = line.indexOf(quote === "(" ? ")" : quote, position + 1)
    if (end === -1) return null
    position = end + 1
    while (line[position] === " ") position++
  }
  if (line[position] !== ")" || !destination) return null
  return { textEnd: close, destination, end: position + 1 }
}

/** Code spans become spaces, so nothing inside one reads as a link. */
function blankCodeSpans(line: string): string {
  if (!line.includes("`")) return line
  let out = ""
  let index = 0
  while (index < line.length) {
    if (line[index] === "\\") {
      out += line.slice(index, index + 2)
      index += 2
      continue
    }
    if (line[index] !== "`") {
      out += line[index]
      index++
      continue
    }
    let run = 0
    while (line[index + run] === "`") run++
    const close = closingRun(line, index + run, run)
    if (close === -1) {
      out += line.slice(index, index + run)
      index += run
      continue
    }
    out += " ".repeat(close + run - index)
    index = close + run
  }
  return out
}

function closingRun(line: string, from: number, length: number): number {
  let index = from
  while (index < line.length) {
    if (line[index] !== "`") {
      index++
      continue
    }
    let run = 0
    while (line[index + run] === "`") run++
    if (run === length) return index
    index += run
  }
  return -1
}

function trimUrl(url: string): string {
  let trimmed = url
  for (;;) {
    const next = trimmed.replace(TRAILING_PUNCTUATION, "")
    const opens = next.split("(").length
    const closes = next.split(")").length
    const unbalanced = next.endsWith(")") && closes > opens ? next.slice(0, -1) : next
    if (unbalanced === trimmed) return trimmed
    trimmed = unbalanced
  }
}

function classify(destination: string, text: string | null): SharedAsset | null {
  const value = destination.trim()
  if (/^https?:\/\/[^/\s]+/i.test(value)) return LOOPBACK_URL.test(value) ? null : { kind: "link", target: value, label: labelFor(text, value) }
  const path = localPath(value)
  if (!path || LINE_REFERENCE.test(path)) return null
  const kind = fileKind(extensionOf(path))
  return kind && { kind, target: path, label: labelFor(text, path) }
}

function fileKind(extension: string): LibraryItemKind | null {
  if (extension in IMAGE_TYPES) return "image"
  if (extension in VIDEO_TYPES) return "video"
  return DOCUMENT_EXTENSIONS.has(extension) ? "file" : null
}

/** The absolute path a destination names, as `localFilePath` reads it for the timeline; null for anything else. */
function localPath(destination: string): string | null {
  let value = destination
  if (/^file:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname
    } catch {
      return null
    }
  }
  try {
    value = decodeURIComponent(value)
  } catch { /* a literal % in a raw path */ }
  if (value.startsWith("/") && WINDOWS_DRIVE.test(value.slice(1))) return value.slice(1)
  if (value.startsWith("//")) return null
  return value.startsWith("/") || WINDOWS_DRIVE.test(value) ? value : null
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
}

/** A path's extension, lower-cased with its dot; empty when it has none. */
export function extensionOf(path: string): string {
  const name = baseName(path)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot).toLowerCase() : ""
}

/** Link or alt text, without markup, when it says more than the target itself. */
function labelFor(text: string | null, target: string): string | null {
  if (!text) return null
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`|\*\*?|~~/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!plain) return null
  const bare = (value: string) => value.replace(/^https?:\/\//i, "").replace(/\/$/, "")
  if (plain === target || plain === baseName(target) || bare(plain) === bare(target)) return null
  return plain.length > MAX_LABEL ? `${plain.slice(0, MAX_LABEL - 1)}…` : plain
}
