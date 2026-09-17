import { createHash } from "node:crypto"
import { z } from "zod"
import { parseManifest, parseConnectionDefinition, type PluginManifest, type ConnectionDefinition } from "@cogpit/plugin-contracts"
import { parseJsonText } from "./json"

export const PACKAGE_LIMITS = Object.freeze({ upload: 4 * 1024 * 1024, expanded: 16 * 1024 * 1024, files: 256, manifest: 64 * 1024, metadata: 256 * 1024 })
const stringMap = z.record(z.string().max(128), z.string().max(PACKAGE_LIMITS.metadata))
const bundleSchema = z.strictObject({
  bundleVersion: z.literal(1),
  publisher: z.string().min(1).max(80),
  targetPath: z.string().min(1).max(240),
  roots: z.array(z.string().max(PACKAGE_LIMITS.metadata)).max(32),
  metadata: stringMap,
  payload: z.string().min(1).max(PACKAGE_LIMITS.upload),
})
const archiveSchema = z.strictObject({
  archiveVersion: z.literal(1),
  files: z.array(z.strictObject({ path: z.string().min(1).max(240), mime: z.string().max(80), content: z.string().max(PACKAGE_LIMITS.expanded) })).min(2).max(PACKAGE_LIMITS.files),
})

export interface InstallBundle {
  publisher: string
  targetPath: string
  roots: Buffer[]
  metadata: Map<string, Buffer>
  payload: Buffer
}

export interface PackageFile { mime: string; bytes: Buffer }
export interface InspectedPackage {
  manifest: PluginManifest
  digest: string
  files: Map<string, PackageFile>
  connections: Map<string, ConnectionDefinition>
  payload: Buffer
}

export function decodeBase64(text: string, limit: number): Buffer {
  if (text.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("Invalid or oversized base64 data")
  const bytes = Buffer.from(text, "base64")
  if (bytes.length > limit || bytes.toString("base64") !== text) throw new Error("Non-canonical or oversized base64 data")
  return bytes
}

export function validatePackagePath(path: string): void {
  if (path.length > 240 || !/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path)) throw new Error(`Invalid package path: ${path.slice(0, 80)}`)
  for (const part of path.split("/")) {
    if (!part || part === "." || part === ".." || part.endsWith(".") || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error(`Unsafe package path: ${path.slice(0, 80)}`)
  }
}

export function decodeInstallBundle(bytes: Buffer): InstallBundle {
  const parsed = bundleSchema.parse(parseJsonText(bytes, PACKAGE_LIMITS.upload))
  validatePackagePath(parsed.targetPath)
  const roots = parsed.roots.map((text) => Buffer.from(text, "utf8"))
  const metadata = new Map(Object.entries(parsed.metadata).map(([name, text]) => [name, Buffer.from(text, "utf8")]))
  if (metadata.size > 32) throw new Error("Too many metadata files")
  for (const name of metadata.keys()) {
    if (!/^(?:[1-9]\d*\.)?[A-Za-z][A-Za-z0-9_-]*\.json$/.test(name) || name === "root.json" || name.endsWith(".root.json")) throw new Error("Invalid metadata filename")
  }
  let expanded = 0
  for (const data of [...roots, ...metadata.values()]) {
    parseJsonText(data, PACKAGE_LIMITS.metadata)
    expanded += data.length
  }
  const payload = decodeBase64(parsed.payload, PACKAGE_LIMITS.upload)
  if (expanded + payload.length > PACKAGE_LIMITS.expanded) throw new Error("Expanded bundle exceeds limit")
  return { publisher: parsed.publisher, targetPath: parsed.targetPath, roots, metadata, payload }
}

const TEXT_TYPES: Readonly<Record<string, string>> = { js: "text/javascript", css: "text/css", json: "application/json", txt: "text/plain", md: "text/plain" }
const IMAGE_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }

function validateFile(path: string, file: PackageFile): void {
  const extension = path.split(".").at(-1)!.toLowerCase()
  const textMime = /^(?:license|notice)(?:\.txt)?$/i.test(path) ? "text/plain" : TEXT_TYPES[extension]
  if (textMime) {
    if (textMime !== file.mime) throw new Error(`Unexpected MIME type: ${path}`)
    new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    return
  }
  if (IMAGE_TYPES[extension] !== file.mime) throw new Error(`Unsupported file type: ${path}`)
  const { bytes } = file
  const valid = extension === "png" ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === "webp" ? bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
      : bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
  if (!valid) throw new Error(`Invalid image bytes: ${path}`)
}

/** Called only after authenticating the payload or checking an app-shipped seed digest. */
export function inspectPackage(payload: Buffer, publisher: string): InspectedPackage {
  const archive = archiveSchema.parse(parseJsonText(payload, PACKAGE_LIMITS.upload))
  const files = new Map<string, PackageFile>()
  const folded = new Set<string>()
  let expanded = payload.length
  for (const entry of archive.files) {
    validatePackagePath(entry.path)
    const canonical = entry.path.toLowerCase()
    if (folded.has(canonical)) throw new Error(`Duplicate package path: ${entry.path}`)
    folded.add(canonical)
    const bytes = decodeBase64(entry.content, PACKAGE_LIMITS.expanded)
    expanded += bytes.length
    if (expanded > PACKAGE_LIMITS.expanded) throw new Error("Expanded package exceeds limit")
    const file = { mime: entry.mime, bytes }
    validateFile(entry.path, file)
    files.set(entry.path, file)
  }
  for (const path of folded) {
    const parts = path.split("/")
    for (let index = 1; index < parts.length; index++) {
      if (folded.has(parts.slice(0, index).join("/"))) throw new Error(`File/directory collision: ${path}`)
    }
  }
  const manifestBytes = files.get("plugin.json")?.bytes
  if (!manifestBytes) throw new Error("Missing plugin.json")
  const manifest = parseManifest(parseJsonText(manifestBytes, PACKAGE_LIMITS.manifest))
  if (manifest.publisher !== publisher) throw new Error("The signing publisher does not own this package")
  if (files.get(manifest.entry)?.mime !== "text/javascript") throw new Error("Missing JavaScript entry")
  if (manifest.style && files.get(manifest.style)?.mime !== "text/css") throw new Error("Missing stylesheet")
  for (const [path, file] of files) {
    if (file.mime === "text/javascript" && path !== manifest.entry) throw new Error("Only the declared JavaScript entry is permitted")
    if (file.mime === "text/css" && path !== manifest.style) throw new Error("Only the declared stylesheet is permitted")
  }
  for (const panel of manifest.contributes.panels) {
    if (panel.icon && !files.get(panel.icon)?.mime.startsWith("image/")) throw new Error(`Missing raster icon: ${panel.icon}`)
  }
  const connections = new Map<string, ConnectionDefinition>()
  for (const grant of manifest.permissions.connections ?? []) {
    const definition = files.get(grant.definition)
    if (!definition || definition.mime !== "application/json") throw new Error(`Missing connection definition: ${grant.definition}`)
    const parsed = parseConnectionDefinition(parseJsonText(definition.bytes, PACKAGE_LIMITS.manifest))
    if (parsed.id !== grant.id) throw new Error("Connection identity differs from its permission")
    for (const operation of grant.operations) {
      if (parsed.operations[operation]?.audience !== "panel") throw new Error(`Invalid granted panel operation: ${operation}`)
    }
    connections.set(grant.id, parsed)
  }
  return { manifest, digest: createHash("sha256").update(payload).digest("hex"), files, connections, payload }
}
