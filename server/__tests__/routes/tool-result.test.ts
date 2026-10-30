// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = vi.hoisted(() => ({ filePath: "" }))
vi.mock("../../sessionPaths", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../sessionPaths")>(),
  resolveSessionFilePath: vi.fn(async () => state.filePath),
}))
vi.mock("../../agents", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../agents")>(),
  storeForPath: () => ({ kind: "claude" }),
}))
vi.mock("../../lib/sessionArchive", () => ({
  archiveReason: () => null,
  readArchive: async () => ({ archived: new Map(), kept: new Set() }),
  setSessionsArchived: vi.fn().mockResolvedValue([]),
}))

import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerProjectRoutes } from "../../routes/projects"
import { registerToolResultRoutes } from "../../routes/tool-result"
import { setDataRoot } from "../../config"
import { __resetEditionForTest, PERSONAL_EDITION } from "../../edition"
import { installFakeEdition } from "../edition/fakeEdition"
import { shareRequestAllowed } from "../../share/allowlist"
import { readElided } from "../../../shared/session/resultProjection"
import { textAssistant, toJsonl, toolUseAssistant, userMsg } from "../../../src/__tests__/fixtures"

const roots: string[] = []
afterEach(() => { __resetEditionForTest(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
beforeEach(() => { const root = mkdtempSync(join(tmpdir(), "cogpit-tool-result-")); roots.push(root); setDataRoot(root) })

const BIG = Array.from({ length: 60_000 }, (_, i) => `row ${i} ${"z".repeat(12)}`).join("\n")

/** A long session: 40 turns, each with one heavy and one small result. */
function writeSession(): string[] {
  const records = Array.from({ length: 40 }, (_, turn) => [
    userMsg(`turn ${turn}`),
    toolUseAssistant("Bash", { command: `dump ${turn}` }, `heavy-${turn}`),
    userMsg([{ type: "tool_result", tool_use_id: `heavy-${turn}`, content: `${turn}:${BIG}` }]),
    toolUseAssistant("Bash", { command: "echo ok" }, `light-${turn}`),
    userMsg([{ type: "tool_result", tool_use_id: `light-${turn}`, content: "ok", is_error: turn % 2 === 0 }]),
    textAssistant(`done ${turn}`),
  ]).flat()
  const lines = toJsonl(records).split("\n")
  state.filePath = join(roots[0]!, "session.jsonl")
  writeFileSync(state.filePath, lines.join("\n") + "\n")
  return lines
}

async function get(register: typeof registerProjectRoutes, prefix: string, path: string) {
  const handler = getRouteHandler(collectRoutes(register), prefix)
  const { req, res, next } = createMockReqRes("GET", path)
  await handler(req, res, next)
  return { status: res._getStatus(), body: res._getData() }
}
const page = (query: string) => get(registerProjectRoutes, "/api/sessions/", `proj-a/session.jsonl${query}`)
const body = (path: string) => get(registerToolResultRoutes, "/api/tool-result/", path)

function refsIn(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const record = JSON.parse(line)
    const content = record.message?.content
    return Array.isArray(content) ? content.flatMap((block: { content?: unknown }) => typeof block.content === "string" && readElided(block.content) ? [readElided(block.content)!.stub.ref] : []) : []
  })
}

describe("transcript pages under result projection v1", () => {
  it("send the same native cursors and line counts as native pages, with heavy bodies left on the server", async () => {
    const lines = writeSession()
    const native = JSON.parse((await page("?tail=30&maxBytes=16777216")).body)
    const projected = JSON.parse((await page("?tail=30&maxBytes=16777216&projection=results-v1")).body)
    expect(projected).toMatchObject({ byteOffset: native.byteOffset, totalSize: native.totalSize, hasMore: native.hasMore })
    expect(projected.tailLines).toHaveLength(native.tailLines.length)
    expect(native.tailLines).toEqual(lines.slice(lines.length - native.tailLines.length))
    const nativeBytes = Buffer.byteLength(JSON.stringify(native))
    const projectedBytes = Buffer.byteLength(JSON.stringify(projected))
    expect(nativeBytes).toBeGreaterThan(1_000_000)
    expect(projectedBytes).toBeLessThan(nativeBytes / 20)

    const older = JSON.parse((await page(`?before=${native.byteOffset}&count=30&projection=results-v1`)).body)
    const olderNative = JSON.parse((await page(`?before=${native.byteOffset}&count=30`)).body)
    expect(older).toMatchObject({ byteOffset: olderNative.byteOffset, hasMore: olderNative.hasMore })
    expect(older.lines).toHaveLength(olderNative.lines.length)
    expect(refsIn(older.lines).length).toBeGreaterThan(0)
  })

  it("leaves the whole-file read byte for byte", async () => {
    const lines = writeSession()
    expect((await page("?projection=results-v1")).body).toBe(lines.join("\n") + "\n")
  })
})

describe("GET /api/tool-result", () => {
  it("serves an elided body in chunks, for the transcript its reference was signed for", async () => {
    writeSession()
    const projected = JSON.parse((await page("?tail=30&projection=results-v1")).body)
    const ref = refsIn(projected.tailLines).at(-1)!
    const first = await body(`proj-a/session.jsonl?ref=${encodeURIComponent(ref)}`)
    expect(first.status).toBe(200)
    const chunk = JSON.parse(first.body)
    expect(chunk).toMatchObject({ kind: "text", start: 0, total: `39:${BIG}`.length })
    expect(chunk.text).toBe(`39:${BIG}`.slice(0, chunk.end))
    const rest = JSON.parse((await body(`proj-a/session.jsonl?ref=${encodeURIComponent(ref)}&start=${chunk.end}`)).body)
    expect(chunk.text + rest.text).toBe(`39:${BIG}`)
    expect(rest.end).toBe(rest.total)

    expect((await body(`proj-b/session.jsonl?ref=${encodeURIComponent(ref)}`)).status).toBe(400)
    expect((await body(`proj-a/session.jsonl?ref=garbage`)).status).toBe(400)
  })

  it("answers stale after an undo cut the line, and checks access to the transcript again", async () => {
    const lines = writeSession()
    const projected = JSON.parse((await page("?tail=30&projection=results-v1")).body)
    const ref = refsIn(projected.tailLines).at(-1)!
    writeFileSync(state.filePath, lines.slice(0, -6).join("\n") + "\n")
    const stale = await body(`proj-a/session.jsonl?ref=${encodeURIComponent(ref)}`)
    expect(stale.status).toBe(410)
    expect(JSON.parse(stale.body)).toMatchObject({ state: "stale" })

    writeSession()
    installFakeEdition({ access: { ...PERSONAL_EDITION.access, authorizeSession: async (_req, res) => { res.statusCode = 404; res.end(); return null } } })
    expect((await body(`proj-a/session.jsonl?ref=${encodeURIComponent(ref)}`)).status).toBe(404)
  })

  it("is reachable by a share guest only for the shared transcript", () => {
    const share = { sessionId: "s1", dirName: "proj-a", fileName: "session.jsonl" }
    expect(shareRequestAllowed("GET", "/api/tool-result/proj-a/session.jsonl?ref=r1.x.y", share)).toBe(true)
    expect(shareRequestAllowed("GET", "/api/tool-result/proj-b/session.jsonl?ref=r1.x.y", share)).toBe(false)
    expect(shareRequestAllowed("GET", "/api/tool-result?ref=r1.x.y", share)).toBe(false)
  })
})
