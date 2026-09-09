import { describe, it, expect } from "bun:test"
import { parseArgs } from "../cli"

describe("CLI arg parsing", () => {
  it("parses search exclusion", () => {
    expect(parseArgs(["search", "auth", "--exclude-session", "current"]).args.excludeSession).toBe("current")
  })

  it("parses search command", () => {
    const cmd = parseArgs(["search", "authentication"])
    expect(cmd.command).toBe("search")
    expect(cmd.args.query).toBe("authentication")
  })

  it("parses search with options", () => {
    const cmd = parseArgs(["search", "auth", "--session", "abc", "--max-age", "7d", "--limit", "50"])
    expect(cmd.command).toBe("search")
    expect(cmd.args.query).toBe("auth")
    expect(cmd.args.session).toBe("abc")
    expect(cmd.args.maxAge).toBe("7d")
    expect(cmd.args.limit).toBe(50)
  })

  it("parses context command", () => {
    const cmd = parseArgs(["context", "abc-123"])
    expect(cmd.command).toBe("context")
    expect(cmd.args.sessionId).toBe("abc-123")
  })

  it("parses context with --turn", () => {
    const cmd = parseArgs(["context", "abc-123", "--turn", "5"])
    expect(cmd.args.turnIndex).toBe(5)
  })

  it("parses context with --agent", () => {
    const cmd = parseArgs(["context", "abc-123", "--agent", "a7f3"])
    expect(cmd.args.agentId).toBe("a7f3")
  })

  it("parses context with --agent and --turn", () => {
    const cmd = parseArgs(["context", "abc-123", "--agent", "a7f3", "--turn", "2"])
    expect(cmd.args.agentId).toBe("a7f3")
    expect(cmd.args.turnIndex).toBe(2)
  })

  it("parses sessions command", () => {
    const cmd = parseArgs(["sessions"])
    expect(cmd.command).toBe("sessions")
  })

  it("parses sessions --current --cwd", () => {
    const cmd = parseArgs(["sessions", "--current", "--cwd", "/path/to/project"])
    expect(cmd.args.current).toBe(true)
    expect(cmd.args.cwd).toBe("/path/to/project")
  })

  it("parses sessions with --limit and --max-age", () => {
    const cmd = parseArgs(["sessions", "--limit", "50", "--max-age", "30d"])
    expect(cmd.args.limit).toBe(50)
    expect(cmd.args.maxAge).toBe("30d")
  })

  it("parses index stats", () => {
    const cmd = parseArgs(["index", "stats"])
    expect(cmd.command).toBe("index")
    expect(cmd.args.subcommand).toBe("stats")
  })

  it("parses index rebuild", () => {
    const cmd = parseArgs(["index", "rebuild"])
    expect(cmd.command).toBe("index")
    expect(cmd.args.subcommand).toBe("rebuild")
  })

  it("parses search --case-sensitive", () => {
    const cmd = parseArgs(["search", "auth", "--case-sensitive"])
    expect(cmd.args.caseSensitive).toBe(true)
  })
})
