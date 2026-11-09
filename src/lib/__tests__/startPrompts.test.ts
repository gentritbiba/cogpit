import { beforeEach, describe, expect, it } from "vitest"
import { makeTurn } from "@/__tests__/fixtures"
import { _resetStartPromptsForTests, rememberStartPrompt, withStartPrompt } from "@/lib/startPrompts"
import { type SessionView } from "../../../shared/session/sessionDigest"

const makeParsedSession = (overrides: Partial<SessionView>) => ({ sessionId: "", turns: [], ...overrides }) as SessionView

beforeEach(() => _resetStartPromptsForTests())

describe("withStartPrompt", () => {
  it("puts the message back on a session whose agent failed before recording it", () => {
    rememberStartPrompt("s1", "Add a footer with my name")
    const failed = makeParsedSession({ sessionId: "s1", turns: [makeTurn({ userMessage: null, isFragment: true })] })
    const shown = withStartPrompt(failed)
    expect(shown.turns[0]).toMatchObject({ userMessage: "Add a footer with my name", isFragment: false })
    expect(failed.turns[0].userMessage).toBeNull()
  })

  it("leaves a transcript that recorded any prompt as it is", () => {
    rememberStartPrompt("s1", "Add a footer")
    const recorded = makeParsedSession({ sessionId: "s1", turns: [makeTurn({ userMessage: "Add a footer" })] })
    expect(withStartPrompt(recorded)).toBe(recorded)
  })

  it("does nothing for a session this window did not start", () => {
    const other = makeParsedSession({ sessionId: "s2", turns: [makeTurn({ userMessage: null })] })
    expect(withStartPrompt(other)).toBe(other)
  })
})
