// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  parseCliVersion,
  parseUserAgentVersion,
} from "../../lib/codexVersion"

describe("parseUserAgentVersion", () => {
  it("reads the codex version out of an initialize user agent", () => {
    expect(
      parseUserAgentVersion(
        "cogpit/0.152.0 (Mac OS 26.2.0; arm64) unknown (cogpit; 1.2.3)",
      ),
    ).toBe("0.152.0")
  })

  it("keeps prerelease suffixes", () => {
    expect(parseUserAgentVersion("cogpit/0.153.0-alpha.2 (x)")).toBe(
      "0.153.0-alpha.2",
    )
  })

  it("returns null for user agents without a version", () => {
    expect(parseUserAgentVersion("codex-test")).toBeNull()
    expect(parseUserAgentVersion("cogpit/unknown (x)")).toBeNull()
    expect(parseUserAgentVersion(undefined)).toBeNull()
  })
})

describe("parseCliVersion", () => {
  it("reads the version out of `codex --version`", () => {
    expect(parseCliVersion("codex-cli 0.152.0\n")).toBe("0.152.0")
  })

  it("returns null when nothing looks like a version", () => {
    expect(parseCliVersion("command not found")).toBeNull()
  })
})
