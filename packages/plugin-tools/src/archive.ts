import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { parseManifest, type PluginManifest } from "@cogpit/plugin-contracts"
import { sha256 } from "./publisher.js"

const TEXT_TYPES: Readonly<Record<string, string>> = { js: "text/javascript", css: "text/css", json: "application/json", txt: "text/plain", md: "text/plain" }
const IMAGE_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }
const MAX_FILES = 256
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024

export interface ArchiveFile {
  path: string
  mime: string
  bytes: Buffer
}

export interface PluginArchive {
  manifest: PluginManifest
  /** Bytes the host verifies and stores; SHA-256 of these is the package digest. */
  payload: Buffer
  digest: string
  files: ArchiveFile[]
}

export interface ArchiveOptions {
  /** Re-sign the package under another publisher: rewrites `publisher` and the id prefix in `plugin.json`. */
  publisher?: string
  /** Replace the manifest version, for development builds that must not reuse a signed version. */
  version?: string
}

export function mimeFor(path: string): string | null {
  const name = path.split("/").at(-1)!
  if (/^(?:license|notice)(?:\.txt)?$/i.test(name)) return "text/plain"
  const extension = name.split(".").at(-1)!.toLowerCase()
  return TEXT_TYPES[extension] ?? IMAGE_TYPES[extension] ?? null
}

async function collect(root: string, directory: string, files: ArchiveFile[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await collect(root, path, files); continue }
    if (!entry.isFile()) throw new Error(`Plugin packages may only contain ordinary files: ${path}`)
    const relativePath = relative(root, path).split(sep).join("/")
    const mime = mimeFor(relativePath)
    if (!mime) throw new Error(`Unsupported file type in package: ${relativePath}`)
    files.push({ path: relativePath, mime, bytes: await readFile(path) })
  }
}

function rewriteManifest(manifest: Record<string, unknown>, options: ArchiveOptions): Record<string, unknown> {
  const next = { ...manifest }
  if (options.publisher) {
    const previous = String(manifest.publisher ?? "")
    const id = String(manifest.id ?? "")
    next.publisher = options.publisher
    next.id = id.startsWith(`${previous}.`) ? `${options.publisher}.${id.slice(previous.length + 1)}` : id
  }
  if (options.version) next.version = options.version
  return next
}

/** Read a built plugin directory into the archive format Cogpit hosts accept. */
export async function createArchive(directory: string, options: ArchiveOptions = {}): Promise<PluginArchive> {
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`)
  const files: ArchiveFile[] = []
  await collect(directory, directory, files)
  if (files.length > MAX_FILES) throw new Error(`Plugin packages may contain at most ${MAX_FILES} files`)
  const manifestFile = files.find(file => file.path === "plugin.json")
  if (!manifestFile) throw new Error("plugin.json is missing from the package directory")
  const manifestJson = rewriteManifest(JSON.parse(manifestFile.bytes.toString("utf8")) as Record<string, unknown>, options)
  const manifest = parseManifest(manifestJson)
  manifestFile.bytes = Buffer.from(JSON.stringify(manifestJson, null, 2))
  const byPath = new Map(files.map(file => [file.path, file]))
  if (byPath.get(manifest.entry)?.mime !== "text/javascript") throw new Error(`Missing JavaScript entry: ${manifest.entry}`)
  if (manifest.style && byPath.get(manifest.style)?.mime !== "text/css") throw new Error(`Missing stylesheet: ${manifest.style}`)
  for (const panel of manifest.contributes.panels) {
    if (!byPath.get(panel.icon)?.mime.startsWith("image/")) throw new Error(`Missing raster icon: ${panel.icon}`)
  }
  for (const connection of manifest.permissions.connections) {
    if (byPath.get(connection.definition)?.mime !== "application/json") throw new Error(`Missing connection definition: ${connection.definition}`)
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const payload = Buffer.from(JSON.stringify({ archiveVersion: 1, files: files.map(file => ({ path: file.path, mime: file.mime, content: file.bytes.toString("base64") })) }))
  if (payload.length > MAX_ARCHIVE_BYTES) throw new Error(`Plugin package exceeds ${MAX_ARCHIVE_BYTES} bytes`)
  return { manifest, payload, digest: sha256(payload), files }
}
