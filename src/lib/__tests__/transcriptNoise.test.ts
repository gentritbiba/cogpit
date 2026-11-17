import { describe, expect, it } from "vitest"

import { formatFor, isAnyAgentNoiseLine } from "../../../shared/session/agents"

const claude = formatFor("claude")

const request = '{"type":"api-request","sessionId":"s","id":"0a","timestamp":"2026-10-20T11:00:40.897Z"}'
const blob = '{"type":"api-request-blob","sessionId":"s","hash":"07","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}'
const shape = '{"type":"api-request-shape","sessionId":"s","shapeHash":"3b","version":"2.1.303","shape":{"system":[]}}'
const user = '{"parentUuid":null,"type":"user","uuid":"u1","sessionId":"s","timestamp":"2026-10-20T11:00:41.000Z","message":{"role":"user","content":"hello"}}'

describe("Claude transcript noise", () => {
  it("names the api-request records Claude Code writes", () => {
    expect([request, blob, shape].every(claude.isNoiseLine)).toBe(true)
    expect(claude.isNoiseLine(user)).toBe(false)
  })

  it("finds the record type wherever the writer put the key", () => {
    expect(claude.isNoiseLine('{"sessionId":"s","type":"api-request-blob","hash":"07"}')).toBe(true)
  })

  it("ignores the same words inside a nested object or a string", () => {
    expect(claude.isNoiseLine('{"type":"user","message":{"type":"api-request"}}')).toBe(false)
    expect(claude.isNoiseLine('{"type":"user","message":{"content":"{\\"type\\":\\"api-request\\"}"}}')).toBe(false)
    expect(claude.isNoiseLine('{"data":{"x":1},"type":"api-request"}')).toBe(false)
  })

  it("is Claude's alone", () => {
    expect(formatFor("codex").isNoiseLine(request)).toBe(false)
    expect(formatFor("copilot").isNoiseLine(request)).toBe(false)
    expect(isAnyAgentNoiseLine(request)).toBe(true)
    expect(isAnyAgentNoiseLine(user)).toBe(false)
  })

  it("parses a transcript the same with or without them", () => {
    const withNoise = claude.parse([shape, blob, user, request].join("\n"))
    const without = claude.parse(user)
    expect(withNoise.turns).toEqual(without.turns)
    expect(withNoise.rawMessages).toEqual(without.rawMessages)
  })
})

const codex = formatFor("codex")

// Lines as Codex 0.144–0.166 write them, contents shortened.
const THREAD = '"thread_id":"01a198ca-2678-7c81-9c28-42c4414edeec","turn_id":"01a198ca-284d-7900-ad7c-fced8b8eae9a"'
const completed = (ordinal: number, item: string) => `{"timestamp":"2026-11-01T20:26:02.172Z","ordinal":${ordinal},"type":"event_msg","payload":{"type":"item_completed",${THREAD},"item":${item},"started_at_ms":1793564760102,"completed_at_ms":1793564762172}}`
const command = completed(24, '{"type":"CommandExecution","id":"exec-91d2b01d","process_id":"64776","command":["/bin/zsh","-lc","gh pr view 12"],"cwd":"/work","aggregated_output":"https://github.com/acme/app/pull/12","exit_code":0,"status":"completed"}')
const image = completed(72, '{"type":"Extension","kind":"image_gen.generation","id":"exec-dad4831e","status":"completed","result":"iVBORw0KGgoAAAANSUhEUgAA","savedPath":"/Users/me/.codex/generated_images/t/exec-dad4831e.png"}')
const said = completed(13, '{"type":"AgentMessage","id":"msg_0a71","content":[{"type":"Text","text":"Checking the filings."}],"phase":"commentary"}')
const subAgent = completed(1316, '{"type":"SubAgentActivity","id":"call_id26","kind":"started","agent_thread_id":"019f8a1b-a3d1-7b32-8e13-0925aec0313d","agent_path":"/root/commit_review"}')
const meta = '{"timestamp":"2026-11-01T20:25:47.000Z","type":"session_meta","payload":{"id":"01a198ca-2678-7c81-9c28-42c4414edeec","cwd":"/work","originator":"cogpit","cli_version":"0.166.0"}}'
const prompt = '{"timestamp":"2026-11-01T20:25:49.400Z","ordinal":11,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the pull request"}]}}'
const reply = '{"timestamp":"2026-11-01T20:26:03.000Z","ordinal":25,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"It is merged."}]}}'
const done = '{"timestamp":"2026-11-01T20:26:03.100Z","ordinal":26,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a198ca-284d-7900-ad7c-fced8b8eae9a","last_agent_message":"It is merged."}}'

describe("Codex transcript noise", () => {
  it("names the completed items Codex also writes as their own records", () => {
    expect([command, image, said].every(codex.isNoiseLine)).toBe(true)
    expect([meta, prompt, reply, done].some(codex.isNoiseLine)).toBe(false)
  })

  it("keeps the sub-agent activity the parser reads", () => {
    expect(codex.isNoiseLine(subAgent)).toBe(false)
  })

  it("ignores the same words inside a nested object or a string", () => {
    expect(codex.isNoiseLine(`{"timestamp":"t","type":"response_item","payload":{"type":"function_call_output","output":${JSON.stringify(command)}}}`)).toBe(false)
    expect(codex.isNoiseLine(`{"meta":{"x":1},"type":"event_msg","payload":{"type":"item_completed",${THREAD},"item":{"type":"Reasoning"}}}`)).toBe(false)
    expect(codex.isNoiseLine(`{"timestamp":"t","type":"event_msg","payload":{"type":"item_completed","extra":{"item":{"type":"Reasoning"}},"item":{"type":"SubAgentActivity"}}}`)).toBe(false)
  })

  it("is Codex's alone", () => {
    expect(claude.isNoiseLine(command)).toBe(false)
    expect(formatFor("copilot").isNoiseLine(command)).toBe(false)
    expect(isAnyAgentNoiseLine(command)).toBe(true)
    expect(isAnyAgentNoiseLine(subAgent)).toBe(false)
  })

  it("parses a rollout the same with or without them", () => {
    const withNoise = codex.parse([meta, prompt, said, command, image, subAgent, reply, done].join("\n"))
    const without = codex.parse([meta, prompt, subAgent, reply, done].join("\n"))
    expect(withNoise.turns).toEqual(without.turns)
    expect(codex.status(withNoise.rawMessages)).toEqual(codex.status(without.rawMessages))
  })
})
