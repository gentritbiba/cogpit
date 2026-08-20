import { describe, expect, it } from "vitest"

import { compareVersions, extractVersion, parseVersion } from "../../../shared/versions"

describe("parseVersion", () => {
  it("parses a release and a prerelease", () => {
    expect(parseVersion("v2.1.220")).toEqual({ parts: [2, 1, 220], prerelease: [] })
    expect(parseVersion("2.1.220-beta.1")).toEqual({
      parts: [2, 1, 220],
      prerelease: ["beta", "1"],
    })
  })

  it("rejects non-versions", () => {
    expect(parseVersion("unknown")).toBeNull()
    expect(parseVersion("2.1")).toBeNull()
  })
})

describe("extractVersion", () => {
  it("pulls the version out of CLI banner output", () => {
    expect(extractVersion("2.1.220 (Claude Code)")).toBe("2.1.220")
    expect(extractVersion("codex-cli 0.52.0\n")).toBe("0.52.0")
    expect(extractVersion("no version here")).toBeNull()
  })
})

describe("compareVersions", () => {
  it("orders by numeric segment", () => {
    expect(compareVersions("2.1.19", "2.1.20")).toBe(-1)
    expect(compareVersions("2.2.0", "2.1.99")).toBe(1)
    expect(compareVersions("3.0.0", "3.0.0")).toBe(0)
  })

  it("treats a release as newer than its own prerelease", () => {
    expect(compareVersions("2.1.0-beta.1", "2.1.0")).toBe(-1)
    expect(compareVersions("2.1.0", "2.1.0-beta.1")).toBe(1)
    expect(compareVersions("2.1.0-beta.2", "2.1.0-beta.10")).toBe(-1)
    expect(compareVersions("2.1.0-alpha", "2.1.0-beta")).toBe(-1)
  })

  it("returns null when either side is unparseable", () => {
    expect(compareVersions("garbage", "2.1.0")).toBeNull()
  })
})
