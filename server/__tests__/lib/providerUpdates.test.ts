// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  _resetProviderUpdateCachesForTests,
  buildUpdateCommand,
  deriveStatus,
  detectInstallMethod,
  fetchLatestVersion,
  formatCommand,
  isProviderUpdateId,
} from "../../lib/providerUpdates"

describe("deriveStatus", () => {
  it("classifies each combination", () => {
    expect(deriveStatus(null, "2.1.0")).toBe("not-installed")
    expect(deriveStatus("2.1.0", null)).toBe("unknown")
    expect(deriveStatus("2.1.0", "2.2.0")).toBe("behind")
    expect(deriveStatus("2.2.0", "2.2.0")).toBe("current")
    // A locally built CLI ahead of the registry is not "behind".
    expect(deriveStatus("2.3.0", "2.2.0")).toBe("current")
    expect(deriveStatus("nonsense", "2.2.0")).toBe("unknown")
  })
})

describe("detectInstallMethod", () => {
  it("recognises the Claude native installer", () => {
    expect(detectInstallMethod("claude", ["/Users/x/.local/bin/claude"])).toBe("native")
    expect(detectInstallMethod("claude", ["/Users/x/.local/share/claude/bin/claude"])).toBe("native")
  })

  it("has no native path for codex", () => {
    expect(detectInstallMethod("codex", ["/Users/x/.local/bin/codex"])).toBe("unknown")
  })

  it("recognises package managers, including through a symlink realpath", () => {
    expect(detectInstallMethod("codex", ["/Users/x/.bun/bin/codex"])).toBe("bun")
    expect(detectInstallMethod("codex", ["/Users/x/Library/pnpm/codex"])).toBe("pnpm")
    expect(
      detectInstallMethod("codex", [
        "/opt/homebrew/bin/codex",
        "/opt/homebrew/Cellar/codex/0.52.0/bin/codex",
      ]),
    ).toBe("homebrew")
    expect(
      detectInstallMethod("claude", [
        "/usr/local/bin/claude",
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      ]),
    ).toBe("npm")
  })

  it("falls back to unknown for unrecognised layouts", () => {
    expect(detectInstallMethod("claude", ["/opt/custom/claude"])).toBe("unknown")
    expect(detectInstallMethod("claude", [])).toBe("unknown")
  })
})

describe("buildUpdateCommand", () => {
  it("maps each install method to its upgrade command", () => {
    expect(formatCommand(buildUpdateCommand("claude", "native")!)).toBe("claude update")
    expect(formatCommand(buildUpdateCommand("claude", "homebrew")!)).toBe("brew upgrade claude-code")
    expect(formatCommand(buildUpdateCommand("codex", "homebrew")!)).toBe("brew upgrade codex")
    expect(formatCommand(buildUpdateCommand("codex", "bun")!)).toBe("bun i -g @openai/codex@latest")
    expect(formatCommand(buildUpdateCommand("codex", "pnpm")!)).toBe("pnpm add -g @openai/codex@latest")
  })

  it("keeps install scripts enabled for the npm global path", () => {
    // Without this, npm 12 skips the postinstall that lays down Claude's real
    // binary and still exits 0 — a silent broken upgrade.
    expect(formatCommand(buildUpdateCommand("claude", "npm")!)).toBe(
      "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest",
    )
  })

  it("refuses to guess for codex native and unknown installs", () => {
    expect(buildUpdateCommand("codex", "native")).toBeNull()
    expect(buildUpdateCommand("claude", "unknown")).toBeNull()
  })

  it("serialises updates that share a global store", () => {
    expect(buildUpdateCommand("claude", "npm")!.lockKey).toBe(
      buildUpdateCommand("codex", "npm")!.lockKey,
    )
    expect(buildUpdateCommand("claude", "npm")!.lockKey).not.toBe(
      buildUpdateCommand("codex", "bun")!.lockKey,
    )
  })
})

describe("isProviderUpdateId", () => {
  it("accepts only known providers", () => {
    expect(isProviderUpdateId("claude")).toBe(true)
    expect(isProviderUpdateId("codex")).toBe(true)
    expect(isProviderUpdateId("cursor")).toBe(false)
    expect(isProviderUpdateId(null)).toBe(false)
  })
})

describe("fetchLatestVersion", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    _resetProviderUpdateCachesForTests()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("reads the registry and caches the answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "2.1.220" }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await fetchLatestVersion("@anthropic-ai/claude-code")).toBe("2.1.220")
    expect(await fetchLatestVersion("@anthropic-ai/claude-code")).toBe("2.1.220")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest",
    )
  })

  it("shares one request between concurrent callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "0.149.0" }),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const [a, b] = await Promise.all([
      fetchLatestVersion("@openai/codex"),
      fetchLatestVersion("@openai/codex"),
    ])
    expect([a, b]).toEqual(["0.149.0", "0.149.0"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("returns null when the registry is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch
    expect(await fetchLatestVersion("@openai/codex")).toBeNull()
  })

  it("returns null on a non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as unknown as typeof fetch
    expect(await fetchLatestVersion("@openai/codex")).toBeNull()
  })
})
