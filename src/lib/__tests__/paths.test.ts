import { describe, expect, it } from "vitest"
import { parentDirectory, relativePathWithin } from "@/lib/paths"

describe("parentDirectory", () => {
  it("returns the containing directory", () => {
    expect(parentDirectory("/repo/src/app.ts")).toBe("/repo/src")
    expect(parentDirectory("/repo/src/")).toBe("/repo")
    expect(parentDirectory("/app.ts")).toBe("/")
  })

  it("handles Windows separators", () => {
    expect(parentDirectory("C:\\repo\\src\\app.ts")).toBe("C:/repo/src")
  })

  it("returns a bare name unchanged", () => {
    expect(parentDirectory("app.ts")).toBe("app.ts")
  })
})

describe("relativePathWithin", () => {
  it("returns the root-relative path", () => {
    expect(relativePathWithin("/repo", "/repo/src/app.ts")).toBe("src/app.ts")
    expect(relativePathWithin("/repo/", "/repo/src/app.ts")).toBe("src/app.ts")
    expect(relativePathWithin("/", "/app.ts")).toBe("app.ts")
  })

  it("returns an empty string when both sides are the same directory", () => {
    expect(relativePathWithin("/repo", "/repo")).toBe("")
  })

  it("rejects paths outside the root", () => {
    expect(relativePathWithin("/repo", "/other/app.ts")).toBeNull()
    // A sibling whose name merely starts with the root must not match.
    expect(relativePathWithin("/repo", "/repo-two/app.ts")).toBeNull()
  })

  it("compares Windows paths case-insensitively", () => {
    expect(relativePathWithin("C:\\Repo", "c:\\repo\\src\\app.ts")).toBe("src/app.ts")
  })

  it("keeps POSIX paths case-sensitive", () => {
    expect(relativePathWithin("/Repo", "/repo/app.ts")).toBeNull()
  })
})
