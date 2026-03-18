/**
 * Provider integration tests — end-to-end: given JSONL text, auto-detect
 * provider, parse, and extract metadata for both Claude and Codex formats.
 */
import { describe, it, expect } from "vitest"
import { parseSession } from "@/lib/parser"
import {
  getProviderForDirName,
  getProviderForSessionText,
  inferAgentKind,
  getProvider,
  isCodexDirName,
  encodeCodexDirName,
  decodeCodexDirName,
  AGENT_KINDS,
} from "../index"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLAUDE_JSONL = JSON.stringify({
  type: "user",
  sessionId: "claude-session-1",
  version: "2.0.0",
  gitBranch: "main",
  cwd: "/project",
  slug: "test",
  message: { role: "user", content: "Hello Claude" },
}) + "\n" + JSON.stringify({
  type: "assistant",
  message: { role: "assistant", model: "claude-3-5-sonnet-20241022", stop_reason: "end_turn", content: [{ type: "text", text: "Hello! How can I help?" }] },
})

const CODEX_JSONL = JSON.stringify({
  type: "session_meta",
  timestamp: "2024-01-01T00:00:00.000Z",
  payload: { id: "codex-session-1", cli_version: "1.0.0", cwd: "/project", git: { branch: "main" } },
}) + "\n" + JSON.stringify({
  type: "turn_context",
  timestamp: "2024-01-01T00:00:01.000Z",
  payload: { turn_id: "t1", model: "gpt-4o", cwd: "/project" },
}) + "\n" + JSON.stringify({
  type: "event_msg",
  timestamp: "2024-01-01T00:00:02.000Z",
  payload: { type: "user_message", message: "Hello Codex" },
}) + "\n" + JSON.stringify({
  type: "response_item",
  timestamp: "2024-01-01T00:00:03.000Z",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello! How can I help?" }] },
})

// ── Registry ──────────────────────────────────────────────────────────────────

describe("getProvider", () => {
  it("returns claude provider for 'claude' kind", () => {
    expect(getProvider("claude").kind).toBe("claude")
  })

  it("returns codex provider for 'codex' kind", () => {
    expect(getProvider("codex").kind).toBe("codex")
  })

  it("throws for unknown kind", () => {
    expect(() => getProvider("unknown" as never)).toThrow()
  })
})

describe("AGENT_KINDS", () => {
  it("contains both supported providers", () => {
    expect(AGENT_KINDS).toContain("claude")
    expect(AGENT_KINDS).toContain("codex")
    expect(AGENT_KINDS).toHaveLength(2)
  })
})

describe("inferAgentKind", () => {
  it("infers claude for plain dirName", () => {
    expect(inferAgentKind("my-project")).toBe("claude")
  })

  it("infers codex for codex__ prefixed dirName", () => {
    const encoded = encodeCodexDirName("/home/user/project")
    expect(inferAgentKind(encoded)).toBe("codex")
  })

  it("infers claude for null", () => {
    expect(inferAgentKind(null)).toBe("claude")
  })

  it("infers claude for undefined", () => {
    expect(inferAgentKind(undefined)).toBe("claude")
  })
})

describe("getProviderForDirName", () => {
  it("returns claude provider for a plain dirName", () => {
    expect(getProviderForDirName("my-project").kind).toBe("claude")
  })

  it("returns codex provider for a codex__ dirName", () => {
    const encoded = encodeCodexDirName("/home/user/project")
    expect(getProviderForDirName(encoded).kind).toBe("codex")
  })
})

describe("getProviderForSessionText", () => {
  it("returns codex provider for Codex JSONL", () => {
    expect(getProviderForSessionText(CODEX_JSONL).kind).toBe("codex")
  })

  it("returns claude provider for Claude JSONL", () => {
    expect(getProviderForSessionText(CLAUDE_JSONL).kind).toBe("claude")
  })

  it("returns claude provider for empty text", () => {
    expect(getProviderForSessionText("").kind).toBe("claude")
  })
})

// ── Codex dirName encoding ────────────────────────────────────────────────────

describe("encodeCodexDirName / decodeCodexDirName", () => {
  it("roundtrips ASCII paths", () => {
    const cwd = "/home/user/my-project"
    expect(decodeCodexDirName(encodeCodexDirName(cwd))).toBe(cwd)
  })

  it("roundtrips paths with spaces and special chars", () => {
    const cwd = "/home/user/my project (2024)"
    expect(decodeCodexDirName(encodeCodexDirName(cwd))).toBe(cwd)
  })

  it("roundtrips unicode paths", () => {
    const cwd = "/home/用户/项目"
    expect(decodeCodexDirName(encodeCodexDirName(cwd))).toBe(cwd)
  })

  it("produces URL-safe characters (no +, /, =)", () => {
    const encoded = encodeCodexDirName("/home/user/project")
    const b64Part = encoded.slice("codex__".length)
    expect(b64Part).not.toContain("+")
    expect(b64Part).not.toContain("/")
    expect(b64Part).not.toContain("=")
  })

  it("decodes null for non-codex dirName", () => {
    expect(decodeCodexDirName("plain-project")).toBeNull()
  })

  it("decodes null for invalid base64", () => {
    expect(decodeCodexDirName("codex__!!!not-valid!!!")).toBeNull()
  })
})

describe("isCodexDirName", () => {
  it("returns true for encoded codex dirNames", () => {
    expect(isCodexDirName(encodeCodexDirName("/any/path"))).toBe(true)
  })

  it("returns false for plain project names", () => {
    expect(isCodexDirName("my-project-dir")).toBe(false)
  })

  it("returns false for null", () => {
    expect(isCodexDirName(null)).toBe(false)
  })
})

// ── Provider arg builders ─────────────────────────────────────────────────────

describe("provider.buildPermArgs", () => {
  it("claude: returns dangerously-skip-permissions with no config", () => {
    const args = getProvider("claude").buildPermArgs()
    expect(args).toContain("--dangerously-skip-permissions")
  })

  it("claude: returns permission-mode args with dontAsk mode", () => {
    const args = getProvider("claude").buildPermArgs({ mode: "dontAsk" })
    expect(args).toContain("--permission-mode")
    expect(args).toContain("dontAsk")
  })

  it("claude: bypassPermissions returns dangerously-skip-permissions", () => {
    const args = getProvider("claude").buildPermArgs({ mode: "bypassPermissions" })
    expect(args).toContain("--dangerously-skip-permissions")
  })

  it("codex: returns on-request workspace-write as default", () => {
    const args = getProvider("codex").buildPermArgs()
    expect(args).toContain("-a")
    expect(args).toContain("on-request")
  })

  it("codex: bypassPermissions returns dangerously-bypass flag", () => {
    const args = getProvider("codex").buildPermArgs({ mode: "bypassPermissions" })
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox")
  })
})

describe("provider.buildModelArgs", () => {
  it("claude: returns --model arg for given model", () => {
    const args = getProvider("claude").buildModelArgs("claude-3-5-sonnet-20241022")
    expect(args).toEqual(["--model", "claude-3-5-sonnet-20241022"])
  })

  it("claude: returns empty array for no model", () => {
    expect(getProvider("claude").buildModelArgs()).toEqual([])
  })

  it("codex: returns -m arg for given model", () => {
    const args = getProvider("codex").buildModelArgs("gpt-4o")
    expect(args).toEqual(["-m", "gpt-4o"])
  })
})

describe("provider.resumeCommand", () => {
  it("claude: returns claude --resume command", () => {
    expect(getProvider("claude").resumeCommand("abc-123")).toBe("claude --resume abc-123")
  })

  it("codex: returns codex resume command", () => {
    expect(getProvider("codex").resumeCommand("abc-123")).toBe("codex resume abc-123")
  })
})

// ── End-to-end: parse + detect ────────────────────────────────────────────────

describe("end-to-end parsing with provider detection", () => {
  it("parses Claude session and sets agentKind=claude", () => {
    const session = parseSession(CLAUDE_JSONL)
    expect(session.agentKind).toBe("claude")
    expect(session.sessionId).toBe("claude-session-1")
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBeTruthy()
  })

  it("parses Codex session and sets agentKind=codex", () => {
    const session = parseSession(CODEX_JSONL)
    expect(session.agentKind).toBe("codex")
    expect(session.sessionId).toBe("codex-session-1")
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0].userMessage).toBe("Hello Codex")
  })

  it("provider detection matches session agentKind for Claude", () => {
    const session = parseSession(CLAUDE_JSONL)
    const detectedProvider = getProviderForSessionText(CLAUDE_JSONL)
    expect(detectedProvider.kind).toBe(session.agentKind)
  })

  it("provider detection matches session agentKind for Codex", () => {
    const session = parseSession(CODEX_JSONL)
    const detectedProvider = getProviderForSessionText(CODEX_JSONL)
    expect(detectedProvider.kind).toBe(session.agentKind)
  })
})
