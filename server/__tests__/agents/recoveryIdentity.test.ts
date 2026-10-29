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

const codexPrompt = { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Original task" }] } }
const codexAssistant = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Turn finished" }] } }
const codexCompleted = { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Turn finished" } }
const image = { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" }
const audio = { type: "input_audio", audio_url: "data:audio/wav;base64,c3ludGhldGlj" }

it.each([
  ["image", image],
  ["audio", audio],
])("hashes Codex %s-only native turns through completion and detects undo", async (_kind, attachment) => {
  const original = lines(codexPrompt, codexAssistant, codexCompleted)
  await writeFile(file, original)
  const before = await recoveryIdentity(file, "codex")
  const input = { type: "response_item", payload: { type: "message", role: "user", content: [attachment] } }
  await appendFile(file, lines(input))
  const afterInput = await recoveryIdentity(file, "codex")
  expect(afterInput).not.toBe(before)
  await appendFile(file, lines(codexAssistant, codexCompleted))
  expect(await recoveryIdentity(file, "codex")).toBe(afterInput)
  await writeFile(file, original)
  expect(await recoveryIdentity(file, "codex")).toBe(before)
})

it("keeps Codex injected context, tools, invalid media and text/media echoes out of native identity", async () => {
  await writeFile(file, lines(codexPrompt))
  const original = await recoveryIdentity(file, "codex")
  await appendFile(file, lines(
    { type: "event_msg", payload: { type: "user_message", message: "Original task" } },
    codexAssistant,
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Developer instructions" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>Injected environment</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /work/app" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "<environment_context>Injected environment</environment_context>" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "tool-1", output: "Tool result" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "unrecognized-image" }] } },
  ))
  expect(await recoveryIdentity(file, "codex")).toBe(original)
  await appendFile(file, lines({ type: "response_item", payload: { type: "message", role: "user", content: [image, audio] } }))
  const withMedia = await recoveryIdentity(file, "codex")
  expect(withMedia).not.toBe(original)
  await appendFile(file, lines({ type: "event_msg", payload: { type: "user_message", message: "", images: [image.image_url], audio: [audio.audio_url] } }))
  expect(await recoveryIdentity(file, "codex")).toBe(withMedia)
})

it.each([
  { images: [image.image_url] },
  { audio: [audio.audio_url] },
  { local_images: ["/synthetic/image.png"] },
  { local_audio: ["/synthetic/audio.wav"] },
])("recognizes legacy attachment-only Codex user events: %j", async (attachments) => {
  await writeFile(file, lines(codexPrompt, codexAssistant, codexCompleted))
  const before = await recoveryIdentity(file, "codex")
  await appendFile(file, lines({ type: "event_msg", payload: { type: "user_message", message: "", ...attachments } }))
  expect(await recoveryIdentity(file, "codex")).not.toBe(before)
})
