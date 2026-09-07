import { describe, expect, it } from "vitest"
import { serverMonogram, splitServerName } from "../settings/mcpNames"

describe("splitServerName", () => {
  it("separates a leading namespace from the server's own name", () => {
    expect(splitServerName("acme.ai Google Drive")).toEqual({ short: "Google Drive", namespace: "acme.ai" })
    expect(splitServerName("next-devtools")).toEqual({ short: "next-devtools" })
    expect(splitServerName("  slack ")).toEqual({ short: "slack" })
  })
})

describe("serverMonogram", () => {
  it("takes initials from the meaningful words", () => {
    expect(serverMonogram("acme.ai Google Drive")).toBe("GD")
    expect(serverMonogram("next-devtools")).toBe("ND")
    expect(serverMonogram("acme.ai AWR MCP Server")).toBe("AW")
  })

  it("falls back to the first two letters of a single word", () => {
    expect(serverMonogram("slack")).toBe("SL")
    expect(serverMonogram("bq")).toBe("BQ")
    expect(serverMonogram("mcp")).toBe("MC")
  })
})
