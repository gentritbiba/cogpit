// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatFor, type AgentKind } from "../../../shared/session/agents"
import { ELISION_THRESHOLD_BYTES, liftElidedResults, previewOf, readElided } from "../../../shared/session/resultProjection"
import type { ParsedSession, ToolCall } from "../../../shared/session/types"
import { decodeRef, projectLine, readResultBody } from "../../agents/resultRefs"
import { setDataRoot } from "../../config"
import { textAssistant, toJsonl, toolUseAssistant, userMsg } from "../../../src/__tests__/fixtures"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function tempDir() { const root = mkdtempSync(join(tmpdir(), "cogpit-result-refs-")); roots.push(root); return root }

const BIG = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(20)} ✓`).join("\n")
const BIG_IMAGE = "iVBORw0KGgo".repeat(4000)
const address = { dirName: "proj-a", fileName: "session.jsonl" }

/** The transcript as a reader of the projection receives it, with each line's native offset. */
function project(kind: AgentKind, lines: string[]): { projected: string[]; offsets: number[] } {
  let cursor = 0
  const offsets = lines.map((line) => { const at = cursor; cursor += Buffer.byteLength(line, "utf8") + 1; return at })
  return { projected: lines.map((line, i) => projectLine(formatFor(kind), line, address, offsets[i]!)), offsets }
}
function calls(session: ParsedSession): ToolCall[] { return session.turns.flatMap((turn) => turn.toolCalls) }
/** Everything the timeline reads from a session apart from result bodies. */
function semantics(session: ParsedSession) {
  return {
    turns: session.turns.map((turn) => ({ blocks: turn.contentBlocks.map((block) => block.kind) })),
    calls: calls(session).map((call) => ({ id: call.id, name: call.name, isError: call.isError, pending: call.result === null, images: call.resultImages?.length ?? 0, awaitingReview: call.awaitingReview, fileDiffs: call.fileDiffs, additionalFileDiffs: call.additionalFileDiffs })),
  }
}

function expectEquivalent(kind: AgentKind, lines: string[]) {
  const format = formatFor(kind)
  const { projected } = project(kind, lines)
  const native = format.parse(lines.join("\n"))
  const light = liftElidedResults(format.parse(projected.join("\n")))
  expect(semantics(light)).toEqual(semantics(native))
  expect(format.status(light.rawMessages)).toEqual(format.status(native.rawMessages))
  expect(projected.length).toBe(lines.length)
  return { native, light, projected }
}

describe("result projection v1", () => {
  it("keeps a Claude transcript's structure, statuses and errors while its bodies stay behind", () => {
    setDataRoot(tempDir())
    const bashDiff = { files: Array.from({ length: 40 }, (_, i) => ({ filePath: `/repo/f${i}.ts`, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${"a".repeat(3000)}`, `+${"b".repeat(3000)}`] }] })) }
    const lines = toJsonl([
      userMsg("Run it"),
      toolUseAssistant("Bash", { command: "cat big" }, "t1"),
      { ...userMsg([{ type: "tool_result", tool_use_id: "t1", content: BIG, is_error: true }]), toolUseResult: { stdout: BIG, stderr: "", interrupted: false, bashEditDiff: bashDiff } },
      toolUseAssistant("Read", { file_path: "/repo/a.png" }, "t2"),
      userMsg([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: BIG }, { type: "image", source: { type: "base64", media_type: "image/png", data: BIG_IMAGE } }] }]),
      toolUseAssistant("Read", { file_path: "/repo/small.ts" }, "t3"),
      userMsg([{ type: "tool_result", tool_use_id: "t3", content: "small output" }]),
      textAssistant("Done"),
    ]).split("\n")
    const { native, light, projected } = expectEquivalent("claude", lines)
    const [bash, read, small] = calls(light)
    expect(bash).toMatchObject({ isError: true, result: previewOf(BIG), resultRef: { bytes: Buffer.byteLength(BIG), lines: 4000, kind: "text", source: address } })
    expect(read!.resultRef).toMatchObject({ bytes: Buffer.byteLength(BIG) })
    expect(readElided(JSON.parse(projected[4]!).message.content[0].content[1].source.data)?.stub).toMatchObject({ kind: "image", bytes: BIG_IMAGE.length })
    expect(small).toMatchObject({ result: "small output" })
    expect(small!.resultRef).toBeUndefined()
    // A structured diff over 64 KB across many files keeps every file and hunk the timeline reviews from.
    expect(JSON.stringify(bashDiff).length).toBeGreaterThan(200_000)
    expect(native.turns[0]!.toolCalls[0]!.fileDiffs).toHaveLength(40)
    expect(light.turns[0]!.toolCalls[0]!.fileDiffs).toEqual(native.turns[0]!.toolCalls[0]!.fileDiffs)
    expect(light.turns[0]!.toolCalls[0]!.additionalFileDiffs).toBeUndefined()
    expect(JSON.parse(projected[2]!).toolUseResult.bashEditDiff).toEqual(bashDiff)
    // Lines without heavy bodies travel byte for byte; the rest is mostly the diff kept for review.
    expect(projected.filter((line, i) => line !== lines[i])).toHaveLength(2)
    expect(lines.join("\n").length).toBeGreaterThan(690_000)
    expect(projected.join("\n").length).toBeLessThan(lines.join("\n").length / 2)
  })

  it("keeps a Codex output's exit status, refusing an elision its reader would read differently", () => {
    setDataRoot(tempDir())
    const call = (id: string) => JSON.stringify({ type: "response_item", timestamp: "2024-01-01T00:00:03.000Z", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: "{\"cmd\":\"x\"}" } })
    const output = (id: string, value: string) => JSON.stringify({ type: "response_item", timestamp: "2024-01-01T00:00:04.000Z", payload: { type: "function_call_output", call_id: id, output: value } })
    const lines = [
      JSON.stringify({ type: "session_meta", timestamp: "2024-01-01T00:00:00.000Z", payload: { id: "codex-session", cli_version: "1.2.3", cwd: "/repo", git: { branch: "main" } } }),
      JSON.stringify({ type: "event_msg", timestamp: "2024-01-01T00:00:02.000Z", payload: { type: "user_message", message: "go" } }),
      call("enveloped"), output("enveloped", JSON.stringify({ output: BIG, metadata: { exit_code: 1 } })),
      call("plain"), output("plain", `${BIG}\nProcess exited with code 2`),
      call("script"), output("script", `Script failed\n${BIG}`),
      call("image"), JSON.stringify({ type: "response_item", timestamp: "2024-01-01T00:00:04.000Z", payload: { type: "function_call_output", call_id: "image", output: [{ type: "input_text", text: "shot" }, { type: "input_image", image_url: `data:image/png;base64,${BIG_IMAGE}` }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "2024-01-01T00:00:04.500Z", payload: { type: "exec_command_end", call_id: "plain", aggregated_output: BIG, exit_code: 2 } }),
    ]
    const { light, projected } = expectEquivalent("codex", lines)
    const [enveloped, plain, script, image] = calls(light)
    expect(readElided(image!.resultImages![0]!.source.data)?.stub).toMatchObject({ kind: "image", bytes: BIG_IMAGE.length })
    expect(enveloped).toMatchObject({ isError: true, resultRef: { bytes: Buffer.byteLength(BIG) } })
    expect(plain).toMatchObject({ isError: true, resultRef: expect.any(Object) })
    expect(plain!.result).toContain("Process exited with code 2")
    // Its status line would no longer open the output, so it travels whole.
    expect(script!.resultRef).toBeUndefined()
    expect(script).toMatchObject({ isError: true, result: `Script failed\n${BIG}` })
    expect(readElided(JSON.parse(projected.at(-1)!).payload.aggregated_output)).not.toBeNull()
  })

  it("keeps a Copilot tool's failure apart from its elided detail", () => {
    setDataRoot(tempDir())
    const event = (type: string, data: Record<string, unknown>, id: string) => JSON.stringify({ type, data, id, timestamp: "2026-08-01T12:00:00.000Z" })
    const lines = [
      event("session.start", { sessionId: "copilot-session", copilotVersion: "1.0.81", selectedModel: "m", context: { cwd: "/repo", branch: "main" } }, "s"),
      event("user.message", { content: "go" }, "u"),
      event("tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: "x" } }, "a"),
      event("tool.execution_complete", { toolCallId: "c1", success: false, result: { content: "short", detailedContent: BIG } }, "b"),
    ]
    const { light } = expectEquivalent("copilot", lines)
    expect(calls(light)[0]).toMatchObject({ isError: true, resultRef: { bytes: Buffer.byteLength(BIG) } })
  })

  it("serves each body back from the exact native line, and calls a changed line stale", async () => {
    const root = tempDir()
    setDataRoot(root)
    const lines = toJsonl([
      userMsg("Run it"),
      toolUseAssistant("Bash", { command: "cat big" }, "t1"),
      { ...userMsg([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: BIG }, { type: "image", source: { type: "base64", media_type: "image/png", data: BIG_IMAGE } }] }]), toolUseResult: { stdout: `${BIG}!` } },
    ]).split("\n")
    const file = join(root, "session.jsonl")
    writeFileSync(file, lines.join("\n") + "\n")
    const { projected } = project("claude", lines)
    const record = JSON.parse(projected[2]!)
    const refs = [record.message.content[0].content[0].text, record.message.content[0].content[1].source.data, record.toolUseResult.stdout].map((text: string) => readElided(text)!.stub.ref)
    const claims = refs.map((ref) => decodeRef(ref)!)
    await expect(Promise.all(claims.map((c) => readResultBody(formatFor("claude"), file, c)))).resolves.toEqual([
      { status: "ok", kind: "text", body: BIG },
      { status: "ok", kind: "image", body: BIG_IMAGE },
      { status: "ok", kind: "text", body: `${BIG}!` },
    ])

    // An undo cut the line away, or a rewrite put other bytes of the same length there.
    writeFileSync(file, lines.slice(0, 2).join("\n") + "\n")
    await expect(readResultBody(formatFor("claude"), file, claims[0]!)).resolves.toEqual({ status: "stale" })
    writeFileSync(file, [...lines.slice(0, 2), lines[2]!.replace("line 1 ", "LINE 1 ")].join("\n") + "\n")
    await expect(readResultBody(formatFor("claude"), file, claims[0]!)).resolves.toEqual({ status: "stale" })

    // A tampered or foreign reference is not one this server signed.
    const [version, body, mac] = refs[0]!.split(".")
    const forged = Buffer.from(JSON.stringify(["proj-a", "../../secret.jsonl", 0, 10, "x", 0])).toString("base64url")
    expect(decodeRef(`${version}.${forged}.${mac}`)).toBeNull()
    expect(decodeRef(`${version}.${body}.${mac!.replace(/.$/, (c) => c === "A" ? "B" : "A")}`)).toBeNull()
    setDataRoot(tempDir())
    expect(decodeRef(refs[0]!)).toBeNull()
  })

  it("leaves lines under the threshold untouched, byte for byte", () => {
    const line = JSON.stringify({ ...userMsg([{ type: "tool_result", tool_use_id: "t", content: "y".repeat(ELISION_THRESHOLD_BYTES - 200) }]) })
    expect(projectLine(formatFor("claude"), line, address, 0)).toBe(line)
    expect(projectLine(formatFor("claude"), "{not json", address, 0)).toBe("{not json")
  })
})
