import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AgentFormat } from "../../shared/session/agents"
import { countLines, ELISION_THRESHOLD_BYTES, elidedText, previewOf, type ElidedResult, type ResultVisitor } from "../../shared/session/resultProjection"
import { getDataRoot } from "../config"
import { openTranscript } from "./transcriptFile"

/**
 * Result projection v1 on the server: projecting transcript lines for a
 * reader that asked for it, and serving one elided body by reference.
 *
 * A reference names the transcript by the same address the reader opened it
 * by, the exact native line by byte offset, length and content hash, and the
 * body by its place in the format's walk. It is signed with a key kept in the
 * data root, so a reader cannot point it anywhere else. Serving re-authorizes
 * the transcript and re-reads the line: an undo, a rewrite or a rotation that
 * changed those bytes makes the reference stale, never a different body.
 */

export interface TranscriptAddress { dirName: string; fileName: string }
interface RefClaims extends TranscriptAddress { offset: number; length: number; hash: string; field: number }

const keys = new Map<string, Buffer>()
function signingKey(): Buffer {
  const file = join(getDataRoot(), "result-refs.key")
  const known = keys.get(file)
  if (known) return known
  let key: Buffer
  try {
    key = Buffer.from(readFileSync(file, "utf8").trim(), "hex")
    if (key.length !== 32) throw new Error("malformed key")
  } catch {
    key = randomBytes(32)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, key.toString("hex"), { mode: 0o600 })
  }
  keys.set(file, key)
  return key
}

function lineHash(line: string): string { return createHash("sha256").update(line).digest("hex").slice(0, 32) }
function signature(body: string): string { return createHmac("sha256", signingKey()).update(body).digest("base64url").slice(0, 32) }

function encodeRef(claims: RefClaims): string {
  const body = Buffer.from(JSON.stringify([claims.dirName, claims.fileName, claims.offset, claims.length, claims.hash, claims.field])).toString("base64url")
  return `r1.${body}.${signature(body)}`
}

/** The claims of a reference this server signed, or null for anything else. */
export function decodeRef(ref: string): RefClaims | null {
  const [version, body, mac] = ref.split(".")
  if (version !== "r1" || !body || !mac || ref.length > 4096) return null
  const expected = Buffer.from(signature(body))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const [dirName, fileName, offset, length, hash, field] = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown[]
    if (typeof dirName !== "string" || typeof fileName !== "string" || typeof hash !== "string") return null
    if (![offset, length, field].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return null
    return { dirName, fileName, offset: offset as number, length: length as number, hash, field: field as number }
  } catch {
    return null
  }
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * The line as a projection reader receives it: unchanged unless it carries a
 * result body over the threshold, which is then elided. `offset` is the
 * line's byte offset in the native file.
 */
export function projectLine(format: Pick<AgentFormat, "projectResults">, line: string, address: TranscriptAddress, offset: number): string {
  if (Buffer.byteLength(line, "utf8") < ELISION_THRESHOLD_BYTES) return line
  const record = parseObject(line)
  if (!record) return line
  let field = 0
  let hash: string | undefined
  const length = Buffer.byteLength(line, "utf8")
  const visit: ResultVisitor = (value, kind) => {
    const index = field++
    const bytes = Buffer.byteLength(value, "utf8")
    if (bytes < ELISION_THRESHOLD_BYTES) return value
    hash ??= lineHash(line)
    const stub: ElidedResult = { ref: encodeRef({ ...address, offset, length, hash, field: index }), bytes, lines: kind === "text" ? countLines(value) : 0, kind, source: { dirName: address.dirName, fileName: address.fileName } }
    return elidedText(stub, kind === "text" ? previewOf(value) : "")
  }
  return format.projectResults(record, visit) ? JSON.stringify(record) : line
}

/** Lines with their native byte offsets, projected; a line without a known offset travels unchanged. */
export function projectLines(format: Pick<AgentFormat, "projectResults">, lines: readonly string[], address: TranscriptAddress, offsetOf: (line: string, index: number) => number | undefined): string[] {
  return lines.map((line, index) => {
    const offset = offsetOf(line, index)
    return offset === undefined ? line : projectLine(format, line, address, offset)
  })
}

/** Most of one native line the server reads back for a body. */
export const MAX_RESULT_LINE_BYTES = 128 * 1024 * 1024

export type ResultBody =
  | { status: "ok"; kind: ElidedResult["kind"]; body: string }
  | { status: "stale" }
  | { status: "too_large" }

/** The body `claims` names in `filePath`, read back from the exact native line it was projected from. */
export async function readResultBody(format: Pick<AgentFormat, "projectResults">, filePath: string, claims: RefClaims): Promise<ResultBody> {
  if (claims.length > MAX_RESULT_LINE_BYTES) return { status: "too_large" }
  const handle = await openTranscript(filePath)
  let line: string
  try {
    const buffer = Buffer.allocUnsafe(claims.length)
    const { bytesRead } = await handle.read(buffer, 0, claims.length, claims.offset)
    if (bytesRead !== claims.length) return { status: "stale" }
    line = buffer.toString("utf8")
  } finally {
    await handle.close()
  }
  if (lineHash(line) !== claims.hash) return { status: "stale" }
  const record = parseObject(line)
  if (!record) return { status: "stale" }
  let field = 0
  let found: { kind: ElidedResult["kind"]; body: string } | null = null
  format.projectResults(record, (value, kind) => {
    if (field++ === claims.field) found = { kind, body: value }
    return value
  })
  return found ? { status: "ok", ...(found as { kind: ElidedResult["kind"]; body: string }) } : { status: "stale" }
}
