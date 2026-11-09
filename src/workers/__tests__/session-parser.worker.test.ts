import { beforeAll, describe, expect, it, vi } from "vitest"
import {
  agentProgressMsg,
  textAssistant,
  toJsonl,
  toolResultMsg,
  toolUseAssistant,
  turnDurationMsg,
  userMsg,
} from "@/__tests__/fixtures"
import { parseSession } from "../../../shared/session/parser"
import { liftElidedResults } from "../../../shared/session/resultProjection"
import { toSessionView, type SessionView } from "../../../shared/session/sessionDigest"
import type { Turn } from "../../../shared/session/types"
import { applySessionDelta } from "@/lib/sessionDelta"
import type { KeptVersion, WorkerRequest, WorkerResponse } from "../session-parser.worker"

const posted: WorkerResponse[] = []
let nextId = 0

beforeAll(async () => {
  vi.stubGlobal("self", { postMessage: (message: WorkerResponse) => posted.push(message) })
  await import("../session-parser.worker")
})

type Request = WorkerRequest extends infer R ? R extends unknown ? Omit<R, "id"> : never : never

function ask(request: Request): WorkerResponse {
  const id = nextId++
  ;(self as unknown as { onmessage: (event: { data: WorkerRequest }) => void }).onmessage({ data: { ...request, id } as WorkerRequest })
  const answer = posted.find((message) => message.id === id)!
  // The worker's reply crosses to the renderer as a copy.
  return structuredClone(answer)
}

/** Parses `text` in the worker and returns the renderer's side of it. */
function open(text: string) {
  const versions = new WeakMap<Turn, number>()
  const answer = ask({ type: "parse", text, keep: true })
  if (answer.type !== "parsed") throw new Error(answer.type)
  answer.view.turns.forEach((turn, index) => versions.set(turn, answer.turnVersions[index]!))
  let view: SessionView = answer.view
  let kept: KeptVersion = answer.kept!
  return {
    get view() { return view },
    get kept() { return kept },
    append(newText: string) {
      const reply = ask({ type: "append", base: kept, newText })
      if (reply.type !== "delta") throw new Error(reply.type)
      view = applySessionDelta(view, reply.delta, versions)
      kept = reply.kept
      return reply.delta
    },
  }
}

const fullView = (text: string) => toSessionView(liftElidedResults(parseSession(text)))

describe("session parser worker", () => {
  const first = [userMsg("hello"), textAssistant("hi there"), turnDurationMsg(100)]
  const second = [userMsg("next"), toolUseAssistant("Bash", { command: "ls" }, "tool-1")]

  it("answers an append with the changed turns only, and the result equals a full parse", () => {
    const session = open(toJsonl([...first, ...second]))
    expect(session.view.turns).toHaveLength(2)
    const before = session.view.turns

    const added = [toolResultMsg("tool-1", "a.ts"), textAssistant("done")]
    const delta = session.append(toJsonl(added))
    expect(delta.fromTurn).toBe(1)
    expect(delta.turns).toHaveLength(1)
    expect(session.view.turns[0]).toBe(before[0])
    expect(session.view.turns.map(({ id }) => id)).toEqual(before.map(({ id }) => id))

    const expected = fullView(toJsonl([...first, ...second, ...added]))
    expect(session.view.turns).toEqual(expected.turns)
    expect(session.view.stats).toEqual(expected.stats)
    expect(session.view.digest).toEqual(expected.digest)
  })

  it("keeps a rebuilt turn that came out unchanged, and the tool call a result did not touch", () => {
    const session = open(toJsonl([...first, ...second]))
    const call = session.view.turns[1]!.toolCalls[0]!
    const delta = session.append(toJsonl([textAssistant("still going")]))
    expect(delta.turns.map(({ id }) => id)).toEqual([session.view.turns[1]!.id])
    expect(session.view.turns[1]!.toolCalls[0]).toBe(call)
  })

  it("rebuilds the earlier turn that late sub-agent progress belongs to", () => {
    const task = [userMsg("use an agent"), toolUseAssistant("Task", { prompt: "go" }, "task-1"), toolResultMsg("task-1", "ok"), textAssistant("done")]
    const later = [userMsg("follow up"), textAssistant("sure")]
    const session = open(toJsonl([...task, ...later]))
    const progress = [agentProgressMsg("agent-1", "task-1", "assistant", [{ type: "text", text: "late" }])]
    session.append(toJsonl(progress))
    expect(session.view.turns).toEqual(fullView(toJsonl([...task, ...later, ...progress])).turns)
  })

  it("answers missing for a version it no longer holds", () => {
    const session = open(toJsonl(first))
    const stale = session.kept
    session.append(toJsonl([userMsg("again")]))
    expect(ask({ type: "append", base: stale, newText: toJsonl([userMsg("x")]) }).type).toBe("missing")
    expect(ask({ type: "append", base: { handle: 999, version: 1 }, newText: "" }).type).toBe("missing")
  })

  it("keeps every session until the renderer releases it (review #2)", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => open(toJsonl([userMsg(`session ${index}`)])))
    expect(() => sessions[0]!.append(toJsonl([userMsg("still here")]))).not.toThrow()

    const { kept } = sessions[0]!
    ;(self as unknown as { onmessage: (event: { data: WorkerRequest }) => void }).onmessage({ data: { type: "release", handle: kept.handle } })
    expect(ask({ type: "append", base: kept, newText: toJsonl([userMsg("gone")]) }).type).toBe("missing")
  })

  it("keeps no session for a page of older turns", () => {
    const answer = ask({ type: "parse", text: toJsonl(first), keep: false })
    expect(answer).toMatchObject({ type: "parsed", kept: null })
  })
})
