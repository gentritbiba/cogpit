// @vitest-environment node
import { describe, it, expect } from "vitest"
import { homedir } from "node:os"
import { join } from "node:path"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { projectDirToReadableName, shortNameFromPath } from "../../lib/projectNames"

// ── projectDirToReadableName ────────────────────────────────────────────

describe("projectDirToReadableName", () => {
  it("converts dir name to path format", () => {
    const result = projectDirToReadableName("home-user-projects-myapp")
    expect(result.path).toBe("/home/user/projects/myapp")
  })

  it("strips leading dash", () => {
    const result = projectDirToReadableName("-home-user-myapp")
    expect(result.path).toBe("/home/user/myapp")
  })

  it("returns shortName as raw if no home prefix match", () => {
    const result = projectDirToReadableName("some-random-dir")
    expect(result.shortName).toBe("some-random-dir")
  })

  it("rebuilds a Windows path from a drive-letter dir name", () => {
    const result = projectDirToReadableName("C--Users-alice-projects-myapp")
    expect(result.path).toBe("C:\\Users\\alice\\projects\\myapp")
  })

  it("shortens a dir name under the current home directory", () => {
    const dirName = descriptorFor("claude").dirName.encode(join(homedir(), "widgets", "app"))
    expect(projectDirToReadableName(dirName).shortName).toBe("widgets-app")
  })
})

// ── shortNameFromPath ───────────────────────────────────────────────────

describe("shortNameFromPath", () => {
  it("returns the last segment", () => {
    expect(shortNameFromPath("/home/user/projects/myapp")).toBe("myapp")
  })

  it("ignores trailing separators of either flavour", () => {
    expect(shortNameFromPath("/home/user/myapp/")).toBe("myapp")
    expect(shortNameFromPath("/home/user/myapp\\")).toBe("myapp")
  })

  it("falls back to the input when there is no segment", () => {
    expect(shortNameFromPath("/")).toBe("/")
  })
})
