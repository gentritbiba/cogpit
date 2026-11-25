// @vitest-environment node
import type { IncomingMessage } from "node:http"
import { describe, expect, it } from "vitest"
import { publicModelName } from "../../agents/publicModels"
import { clientSurface, sanitizeProperties, settingToken } from "../../telemetry/events"
import { builtInToolName } from "../../../shared/session/toolSummary"
import { routeFeature } from "../../telemetry/features"
import { daysToReport } from "../../telemetry/usage"

function request(fields: { url?: string; originalUrl?: string; headers?: Record<string, string> }): IncomingMessage {
  return { headers: {}, ...fields } as unknown as IncomingMessage
}

describe("publicModelName", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5-20250929"],
    ["anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"],
    ["opus[1m]", "opus"],
    ["GPT-5.5-Codex", "gpt-5.5-codex"],
    ["o3", "o3"],
    ["gemini-2.5-pro", "gemini-2.5-pro"],
    ["llama3:8b", "other"],
    ["acme-internal-finetune", "other"],
    ["gpt-5 with spaces", "other"],
  ])("%s reports as %s", (model, expected) => {
    expect(publicModelName(model)).toBe(expected)
  })

  it("reports nothing for no model", () => {
    expect(publicModelName(undefined)).toBeUndefined()
    expect(publicModelName("  ")).toBeUndefined()
  })
})

describe("sanitizeProperties", () => {
  it("keeps short tokens, finite numbers and booleans only", () => {
    expect(sanitizeProperties({
      ok: "abc-1.2",
      timezone: "America/Argentina/Buenos_Aires",
      count: 3,
      ratio: 0.1234567891,
      flag: false,
      path: "/home/someone/project",
      sentence: "a prompt with spaces",
      infinite: Number.POSITIVE_INFINITY,
      nested: { a: 1 },
      long: "x".repeat(80),
    })).toEqual({ ok: "abc-1.2", timezone: "America/Argentina/Buenos_Aires", count: 3, ratio: 0.123457, flag: false })
  })

  it("accepts only short setting names", () => {
    expect(settingToken("bypassPermissions")).toBe("bypassPermissions")
    expect(settingToken("on request")).toBeUndefined()
    expect(settingToken(3)).toBeUndefined()
  })
})

describe("clientSurface", () => {
  it.each([
    [{ headers: { "user-agent": "Mozilla/5.0 Cogpit Electron/39.0.0 Chrome/140" } }, "desktop"],
    [{ headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)" } }, "mobile"],
    [{ headers: { "user-agent": "Mozilla/5.0 (Macintosh)" } }, "browser"],
    [{ headers: { "x-cogpit-session-scope": "local", "user-agent": "Mozilla/5.0" } }, "hub"],
    [{ url: "/", originalUrl: "/api/session-cli", headers: {} }, "agent"],
    [{ headers: { "user-agent": "curl/8" } }, "other"],
  ])("%o is %s", (fields, expected) => {
    expect(clientSurface(request(fields))).toBe(expected)
  })
})

describe("builtInToolName", () => {
  it("keeps the names agents ship and hides the ones people give", () => {
    expect(builtInToolName("Bash")).toBe("Bash")
    expect(builtInToolName("functions.apply_patch")).toBe("apply_patch")
    expect(builtInToolName("WebSearch")).toBe("WebSearch")
    expect(builtInToolName("mcp__acme__deploy")).toBe("mcp")
    expect(builtInToolName("Read /home/someone/file.txt")).toBe("other")
  })
})

describe("routeFeature", () => {
  it("names features by method and path, never by the ids in it", () => {
    expect(routeFeature("POST", "/api/permissions/session-123/respond")).toBe("permission.answer")
    expect(routeFeature("POST", "/api/worktrees/my-branch/create-pr")).toBe("worktree.create_pr")
    expect(routeFeature("POST", "/api/shares")).toBe("share.create")
    expect(routeFeature("DELETE", "/api/library/items/12")).toBe("library.remove")
    expect(routeFeature("PUT", "/api/automations/task-1")).toBe("automation.update")
  })

  it("ignores reads and unknown paths", () => {
    expect(routeFeature("GET", "/api/shares")).toBeUndefined()
    expect(routeFeature("POST", "/api/shares/extra")).toBeUndefined()
    expect(routeFeature("POST", "/api/session-status/x")).toBeUndefined()
  })
})

describe("daysToReport", () => {
  const now = Date.parse("2026-11-22T12:00:00Z")

  it("lists the finished days after the last one reported", () => {
    expect(daysToReport("2026-11-19", now)).toEqual(["2026-11-20", "2026-11-21"])
    expect(daysToReport("2026-11-21", now)).toEqual([])
    expect(daysToReport(null, now)).toEqual([])
  })

  it("reports only the last week after a long gap", () => {
    expect(daysToReport("2026-10-01", now)).toEqual(["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"])
  })
})
