// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

import { parseMcpListOutput, getMcpServers, clearMcpCache } from "../../routes/mcp"

describe("parseMcpListOutput", () => {
  it("parses connected stdio server", () => {
    const output = "Checking MCP server health...\n\nnext-devtools: npx -y next-devtools-mcp@latest - ✓ Connected\n"
    const result = parseMcpListOutput(output)
    expect(result).toContainEqual({
      name: "next-devtools",
      status: "connected",
    })
  })

  it("parses server needing auth", () => {
    const output = "Checking MCP server health...\n\nclaude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication\n"
    const result = parseMcpListOutput(output)
    expect(result).toContainEqual({
      name: "claude.ai Gmail",
      status: "needs_auth",
    })
  })

  it("parses multiple servers of mixed status", () => {
    const output = [
      "Checking MCP server health...",
      "",
      "claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ! Needs authentication",
      "claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication",
      "next-devtools: npx -y next-devtools-mcp@latest - ✓ Connected",
      "clickup: npx -y mcp-remote https://mcp.clickup.com/mcp - ✓ Connected",
      "gitnexus: npx -y gitnexus mcp - ✓ Connected",
      "",
    ].join("\n")
    const result = parseMcpListOutput(output)
    expect(result).toHaveLength(5)
    expect(result.filter(s => s.status === "connected")).toHaveLength(3)
    expect(result.filter(s => s.status === "needs_auth")).toHaveLength(2)
  })

  it("returns empty array for empty output", () => {
    expect(parseMcpListOutput("")).toEqual([])
  })

  it("ignores the 'Checking MCP server health...' header line", () => {
    const output = "Checking MCP server health...\n"
    expect(parseMcpListOutput(output)).toEqual([])
  })

  it("handles error status servers", () => {
    const output = "broken-server: some-cmd - ✗ Error: connection refused\n"
    const result = parseMcpListOutput(output)
    expect(result).toContainEqual({
      name: "broken-server",
      status: "error",
    })
  })
})

describe("getMcpServers", () => {
  beforeEach(() => clearMcpCache())

  it("returns cached result within TTL", async () => {
    const { execFile } = await import("node:child_process")
    const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
    let callCount = 0
    mockExec.mockImplementation((_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
      callCount++
      cb(null, "test-server: cmd - ✓ Connected\n")
    })

    const first = await getMcpServers("/some/path")
    const second = await getMcpServers("/some/path")
    expect(first).toEqual(second)
    expect(callCount).toBe(1) // Only called once due to cache
  })

  it("returns empty array on exec error when no cache", async () => {
    const { execFile } = await import("node:child_process")
    const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
    mockExec.mockImplementation((_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
      cb(new Error("command not found"), "")
    })

    const result = await getMcpServers("/some/path")
    expect(result).toEqual([])
  })

  it("uses different cache keys for different cwds", async () => {
    const { execFile } = await import("node:child_process")
    const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
    let callCount = 0
    mockExec.mockImplementation((_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
      callCount++
      cb(null, `server-${callCount}: cmd - ✓ Connected\n`)
    })

    const first = await getMcpServers("/path/a")
    const second = await getMcpServers("/path/b")
    expect(callCount).toBe(2) // Called once per unique cwd
    expect(first).not.toEqual(second)
  })

  it("clearMcpCache clears specific cwd", async () => {
    const { execFile } = await import("node:child_process")
    const mockExec = execFile as unknown as ReturnType<typeof vi.fn>
    let callCount = 0
    mockExec.mockImplementation((_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
      callCount++
      cb(null, "test-server: cmd - ✓ Connected\n")
    })

    await getMcpServers("/some/path")
    expect(callCount).toBe(1)

    clearMcpCache("/some/path")
    await getMcpServers("/some/path")
    expect(callCount).toBe(2) // Called again after cache clear
  })
})
