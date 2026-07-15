import { describe, expect, it } from "vitest"
import { findFileMention, replaceFileMention } from "@/lib/fileMentions"

describe("file mentions", () => {
  it("finds an at-mention at the end of a prompt", () => {
    expect(findFileMention("Please inspect @src/comp")).toEqual({
      start: 15,
      query: "src/comp",
    })
  })

  it("does not treat email addresses as file mentions", () => {
    expect(findFileMention("email dev@example.com")).toBeNull()
  })

  it("replaces only the active mention", () => {
    const text = "Compare @src/old"
    const mention = findFileMention(text)!
    expect(replaceFileMention(text, mention, "src/new.ts")).toBe("Compare @src/new.ts ")
  })
})
