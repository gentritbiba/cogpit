// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { recoveryIdentity } from "../../agents/recoveryIdentity"
import type { AgentKind } from "../../../shared/session/agent-descriptors"

let root: string
let file: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "native-recovery-id-")); file = join(root, "native.jsonl") })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const user = (content: unknown, uuid = "prompt-1") => ({ type: "user", uuid, message: { role: "user", content } })
const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n"

it("ignores assistant output, tool results, noise and malformed lines", async () => {
  await writeFile(file, lines(user("Task")))
  const before = await recoveryIdentity(file, "claude")
  await appendFile(file, lines(
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Stopped" }] } },
    user([{ type: "tool_result", tool_use_id: "tool-1", content: "Done" }]),
    { type: "progress", data: { type: "hook_progress" } },
  ) + "malformed\n")
  expect(await recoveryIdentity(file, "claude")).toBe(before)
})

it("detects image-only user work and identical text sent as a new native turn", async () => {
  await writeFile(file, lines(user("Task")))
  const first = await recoveryIdentity(file, "claude")
  await appendFile(file, lines(user([{ type: "image", source: { type: "base64", media_type: "image/png", data: "synthetic" } }], "image-prompt")))
  const second = await recoveryIdentity(file, "claude")
  expect(second).not.toBe(first)
  await appendFile(file, lines(user("Task", "prompt-2")))
  expect(await recoveryIdentity(file, "claude")).not.toBe(second)
})

it.each<[AgentKind, unknown, unknown]>([
  ["codex", { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First" }] } }, { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Second" }] } }],
  ["copilot", { type: "user.message", id: "u-1", data: { content: "First" } }, { type: "user.message", id: "u-2", data: { content: "Second" } }],
  ["acp", user("First"), user("Second", "u-2")],
])("uses the canonical %s user-turn format", async (kind, first, second) => {
  await writeFile(file, lines(first))
  const before = await recoveryIdentity(file, kind)
  await appendFile(file, lines(second))
  expect(await recoveryIdentity(file, kind)).not.toBe(before)
  await writeFile(file, lines(first))
  expect(await recoveryIdentity(file, kind)).toBe(before)
})
