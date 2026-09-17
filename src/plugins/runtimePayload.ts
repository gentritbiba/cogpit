import { parseManifest, type PluginManifest } from "@cogpit/plugin-contracts"
import { ident, string as cssString, tokenize, tokenTypes, url } from "css-tree"
import { z } from "zod"

const MAX_UPLOAD = 4 * 1024 * 1024
const MAX_EXPANDED = 16 * 1024 * 1024
const archiveSchema = z.strictObject({ archiveVersion: z.literal(1), files: z.array(z.strictObject({
  path: z.string().min(1).max(240), mime: z.string().max(80), content: z.string().max(MAX_EXPANDED),
})).min(2).max(256) })

export interface RuntimeAsset { path: string; mime: string; bytes: ArrayBuffer }
export interface PreparedRuntimePackage { manifest: PluginManifest; entry: string; style: string | null; assets: RuntimeAsset[] }

function rasterMatches(path: string, mime: string, bytes: Uint8Array): boolean {
  const starts = (prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  if (mime === "image/png") return /\.png$/i.test(path) && bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10])
  if (mime === "image/jpeg") return /\.jpe?g$/i.test(path) && bytes.length >= 4 && starts([255, 216]) && bytes.at(-2) === 255 && bytes.at(-1) === 217
  return /\.webp$/i.test(path) && bytes.length >= 16 && starts([82, 73, 70, 70]) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80
}

function checkPath(path: string): void {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".") || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error("Invalid package asset path")
}

function decode(content: string): Uint8Array {
  if (content.length > MAX_EXPANDED || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) throw new Error("Invalid package encoding")
  const text = atob(content)
  if (btoa(text) !== content) throw new Error("Non-canonical package encoding")
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}

function resolveStyleAsset(reference: string, path: string, images: Set<string>): string {
  if (!reference || /[:?#%]/.test(reference) || reference.startsWith("/")) throw new Error("Stylesheet references an external asset")
  const parts = path.split("/").slice(0, -1)
  for (const part of reference.split("/")) {
    if (part === "..") { if (!parts.length) throw new Error("Stylesheet asset escapes package"); parts.pop() }
    else if (part !== ".") parts.push(part)
  }
  const resolved = parts.join("/")
  checkPath(resolved)
  if (!images.has(resolved)) throw new Error("Stylesheet references an unavailable raster asset")
  return `url("${resolved}")`
}

function prepareStyle(text: string, path: string, images: Set<string>): string {
  const tokens: { type: number; value: string }[] = []
  const closing: number[] = []
  tokenize(text, (type, start, end) => {
    if (tokens.length >= 200_000) throw new Error("Stylesheet exceeds its token limit")
    const value = text.slice(start, end)
    if (type === tokenTypes.BadString || type === tokenTypes.BadUrl) throw new Error("Malformed stylesheet resource")
    if (type === tokenTypes.Function || type === tokenTypes.LeftParenthesis) closing.push(tokenTypes.RightParenthesis)
    else if (type === tokenTypes.LeftCurlyBracket) closing.push(tokenTypes.RightCurlyBracket)
    else if (type === tokenTypes.LeftSquareBracket) closing.push(tokenTypes.RightSquareBracket)
    else if ([tokenTypes.RightParenthesis, tokenTypes.RightCurlyBracket, tokenTypes.RightSquareBracket].includes(type) && closing.pop() !== type) throw new Error("Unbalanced stylesheet")
    if (closing.length > 128) throw new Error("Stylesheet exceeds its nesting limit")
    tokens.push({ type, value })
  })
  if (closing.length) throw new Error("Unbalanced stylesheet")
  const output: string[] = []
  const nextContent = (index: number) => {
    while (tokens[index]?.type === tokenTypes.WhiteSpace || tokens[index]?.type === tokenTypes.Comment) index++
    return index
  }
  for (let index = 0; index < tokens.length; index++) {
    const { type, value } = tokens[index]
    if (type === tokenTypes.AtKeyword && ["import", "font-face"].includes(ident.decode(value.slice(1)).toLowerCase())) throw new Error("Stylesheet imports and font sources are unsupported")
    if (type === tokenTypes.Function) {
      const name = ident.decode(value.slice(0, -1)).toLowerCase()
      if (["image", "image-set", "-webkit-image-set", "src"].includes(name)) throw new Error("Unsupported stylesheet resource function")
      if (name === "url") {
        const stringIndex = nextContent(index + 1), closeIndex = nextContent(stringIndex + 1)
        if (tokens[stringIndex]?.type !== tokenTypes.String || tokens[closeIndex]?.type !== tokenTypes.RightParenthesis) throw new Error("Malformed stylesheet URL")
        output.push(resolveStyleAsset(cssString.decode(tokens[stringIndex].value), path, images))
        index = closeIndex
        continue
      }
    }
    if (type === tokenTypes.Url) {
      if (!value.endsWith(")")) throw new Error("Malformed stylesheet URL")
      output.push(resolveStyleAsset(url.decode(value), path, images))
    } else if (type === tokenTypes.String) {
      if (value.length < 2 || value.at(-1) !== value[0]) throw new Error("Unterminated stylesheet string")
      output.push(cssString.encode(cssString.decode(value)))
    } else if (type === tokenTypes.Comment) {
      if (!value.endsWith("*/")) throw new Error("Unterminated stylesheet comment")
      output.push(" ")
    } else output.push(value)
  }
  return output.join("")
}

export async function prepareRuntimePackage(payload: ArrayBuffer, digest: string, cryptoApi: Crypto = globalThis.crypto): Promise<PreparedRuntimePackage> {
  if (!cryptoApi?.subtle) throw new Error("Plugin integrity verification requires a secure browser connection with Web Crypto")
  if (!/^[a-f0-9]{64}$/.test(digest) || payload.byteLength > MAX_UPLOAD) throw new Error("Invalid package digest or size")
  const copied = payload.slice(0)
  const hash = Array.from(new Uint8Array(await cryptoApi.subtle.digest("SHA-256", copied)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  if (hash !== digest) throw new Error("Plugin package failed integrity verification")
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const archive = archiveSchema.parse(JSON.parse(decoder.decode(copied)))
  const files = new Map<string, { mime: string; bytes: Uint8Array }>()
  const folded = new Set<string>()
  let expanded = copied.byteLength
  for (const file of archive.files) {
    checkPath(file.path)
    if (folded.has(file.path.toLowerCase())) throw new Error("Duplicate package asset path")
    folded.add(file.path.toLowerCase())
    const bytes = decode(file.content)
    expanded += bytes.byteLength
    if (expanded > MAX_EXPANDED) throw new Error("Expanded plugin package exceeds its limit")
    files.set(file.path, { mime: file.mime, bytes })
  }
  for (const path of folded) {
    const parts = path.split("/")
    if (parts.slice(0, -1).some((_, index) => folded.has(parts.slice(0, index + 1).join("/")))) throw new Error("Package file/directory collision")
  }
  const manifestFile = files.get("plugin.json")
  if (!manifestFile || manifestFile.mime !== "application/json" || manifestFile.bytes.byteLength > 65536) throw new Error("Missing or invalid plugin manifest")
  const manifest = parseManifest(JSON.parse(decoder.decode(manifestFile.bytes)))
  const entry = files.get(manifest.entry)
  if (!entry || entry.mime !== "text/javascript") throw new Error("Missing plugin entry")
  const assets: RuntimeAsset[] = []
  for (const [path, file] of files) {
    if (file.mime === "text/javascript" && path !== manifest.entry) throw new Error("Undeclared JavaScript entry")
    if (file.mime === "text/css" && path !== manifest.style) throw new Error("Undeclared stylesheet")
    if (["image/png", "image/jpeg", "image/webp"].includes(file.mime)) {
      if (!rasterMatches(path, file.mime, file.bytes)) throw new Error("Invalid raster package asset")
      assets.push({ path, mime: file.mime, bytes: file.bytes.buffer as ArrayBuffer })
    }
    else if (!["text/javascript", "text/css", "text/plain", "application/json"].includes(file.mime)) throw new Error("Unsupported package asset MIME")
  }
  const images = new Set(assets.map((asset) => asset.path))
  if (manifest.contributes.panels.some((panel) => !images.has(panel.icon))) throw new Error("Missing panel raster icon")
  const stylesheet = manifest.style ? files.get(manifest.style) : null
  if (manifest.style && (!stylesheet || stylesheet.mime !== "text/css")) throw new Error("Missing plugin stylesheet")
  return { manifest, entry: decoder.decode(entry.bytes), style: stylesheet ? prepareStyle(decoder.decode(stylesheet.bytes), manifest.style!, images) : null, assets }
}
