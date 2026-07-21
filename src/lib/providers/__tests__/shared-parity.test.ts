import { describe, expect, expectTypeOf, it } from "vitest"
import * as claudeFacade from "../claude"
import * as codexFacade from "../codex"
import {
  AGENT_KINDS as facadeAgentKinds,
  type AgentKind as FacadeAgentKind,
  type PermissionsConfig as FacadePermissionsConfig,
  type SessionProvider as FacadeSessionProvider,
} from "../types"
import * as sharedClaude from "../../../../shared/providers/claude"
import * as sharedCodex from "../../../../shared/providers/codex"
import {
  AGENT_KINDS as sharedAgentKinds,
  type AgentKind as SharedAgentKind,
  type PermissionsConfig as SharedPermissionsConfig,
  type SessionProvider as SharedSessionProvider,
} from "../../../../shared/providers/types"

describe("shared provider contract parity", () => {
  it("keeps the renderer types and provider-kind value on the shared contract", () => {
    expectTypeOf<FacadeAgentKind>().toEqualTypeOf<SharedAgentKind>()
    expectTypeOf<FacadePermissionsConfig>().toEqualTypeOf<SharedPermissionsConfig>()
    expectTypeOf<FacadeSessionProvider>().toEqualTypeOf<SharedSessionProvider>()
    expect(facadeAgentKinds).toBe(sharedAgentKinds)
  })

  it("keeps Claude facade exports bound to the canonical implementations", () => {
    expect(claudeFacade.encodeClaudeDirName).toBe(sharedClaude.encodeClaudeDirName)
    expect(claudeFacade.buildClaudePermArgs).toBe(sharedClaude.buildClaudePermArgs)
    expect(claudeFacade.buildClaudeModelArgs).toBe(sharedClaude.buildClaudeModelArgs)
    expect(claudeFacade.buildClaudeEffortArgs).toBe(sharedClaude.buildClaudeEffortArgs)
  })

  it("preserves Claude argument ordering and edge-case behavior", () => {
    const permissions: Array<SharedPermissionsConfig | undefined> = [
      undefined,
      {},
      { mode: "" },
      { mode: "default" },
      { mode: "plan", allowedTools: ["Bash", "Read"], disallowedTools: ["Write"] },
      { mode: "bypassPermissions", allowedTools: ["ignored"] },
      { mode: "delegate", allowedTools: ["Task"], disallowedTools: ["Bash"] },
    ]

    for (const config of permissions) {
      expect(claudeFacade.buildClaudePermArgs(config)).toEqual(sharedClaude.buildClaudePermArgs(config))
    }
    for (const value of [undefined, "", "claude-sonnet-4-5", "model with spaces"]) {
      expect(claudeFacade.buildClaudeModelArgs(value)).toEqual(sharedClaude.buildClaudeModelArgs(value))
      expect(claudeFacade.buildClaudeEffortArgs(value)).toEqual(sharedClaude.buildClaudeEffortArgs(value))
    }
  })

  it("keeps Codex facade exports bound to the canonical implementations", () => {
    expect(codexFacade.CODEX_PREFIX).toBe(sharedCodex.CODEX_PREFIX)
    expect(codexFacade.isCodexDirName).toBe(sharedCodex.isCodexDirName)
    expect(codexFacade.encodeCodexDirName).toBe(sharedCodex.encodeCodexDirName)
    expect(codexFacade.decodeCodexDirName).toBe(sharedCodex.decodeCodexDirName)
    expect(codexFacade.buildCodexPermArgs).toBe(sharedCodex.buildCodexPermArgs)
    expect(codexFacade.buildCodexModelArgs).toBe(sharedCodex.buildCodexModelArgs)
    expect(codexFacade.buildCodexEffortArgs).toBe(sharedCodex.buildCodexEffortArgs)
    expect(codexFacade.buildCodexFastModeArgs).toBe(sharedCodex.buildCodexFastModeArgs)
  })

  it("preserves Codex argument ordering, quoting, and directory codecs", () => {
    const permissions: Array<SharedPermissionsConfig | undefined> = [
      undefined,
      {},
      { mode: "" },
      { mode: "default" },
      { mode: "plan" },
      { mode: "bypassPermissions" },
      { mode: "unknown", allowedTools: ["ignored"] },
    ]
    for (const config of permissions) {
      expect(codexFacade.buildCodexPermArgs(config)).toEqual(sharedCodex.buildCodexPermArgs(config))
    }
    for (const value of [undefined, "", "gpt-5.4", "xhigh", 'quoted "value"', "line\nbreak"]) {
      expect(codexFacade.buildCodexModelArgs(value)).toEqual(sharedCodex.buildCodexModelArgs(value))
      expect(codexFacade.buildCodexEffortArgs(value)).toEqual(sharedCodex.buildCodexEffortArgs(value))
    }
    for (const enabled of [undefined, false, true]) {
      expect(codexFacade.buildCodexFastModeArgs(enabled)).toEqual(sharedCodex.buildCodexFastModeArgs(enabled))
    }

    for (const cwd of ["/tmp/project", "/tmp/project with spaces", "/home/用户/项目", "C:\\work\\repo\\"]) {
      const encoded = codexFacade.encodeCodexDirName(cwd)
      expect(encoded).toBe(sharedCodex.encodeCodexDirName(cwd))
      expect(codexFacade.decodeCodexDirName(encoded)).toBe(cwd)
      expect(codexFacade.isCodexDirName(encoded)).toBe(true)
    }
    for (const dirName of ["", "plain-project", "codex__!!!not-valid!!!"]) {
      expect(codexFacade.decodeCodexDirName(dirName)).toBe(sharedCodex.decodeCodexDirName(dirName))
    }
  })
})
