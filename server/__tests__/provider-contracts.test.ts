// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  buildCodexEffortArgs,
  buildCodexFastModeArgs,
  buildCodexModelArgs,
  buildCodexPermArgs,
  buildPermArgs,
  decodeCodexDirName,
  encodeCodexDirName,
  isCodexDirName,
} from "../helpers"
import {
  buildClaudePermArgs,
  buildCodexEffortArgs as sharedBuildCodexEffortArgs,
  buildCodexFastModeArgs as sharedBuildCodexFastModeArgs,
  buildCodexModelArgs as sharedBuildCodexModelArgs,
  buildCodexPermArgs as sharedBuildCodexPermArgs,
  decodeCodexDirName as sharedDecodeCodexDirName,
  encodeCodexDirName as sharedEncodeCodexDirName,
  isCodexDirName as sharedIsCodexDirName,
} from "../../shared/providers"
import type { PermissionsConfig } from "../../shared/providers/types"

describe("server provider compatibility facade", () => {
  it("delegates permission arguments to the shared implementations", () => {
    const cases: Array<PermissionsConfig | undefined> = [
      undefined,
      {},
      { mode: "" },
      { mode: "default" },
      { mode: "plan", allowedTools: ["Read"], disallowedTools: ["Write"] },
      { mode: "bypassPermissions" },
      { mode: "unknown", allowedTools: ["Task"] },
    ]

    for (const config of cases) {
      expect(buildPermArgs(config)).toEqual(buildClaudePermArgs(config))
      expect(buildCodexPermArgs(config)).toEqual(sharedBuildCodexPermArgs(config))
    }
  })

  it("delegates Codex effort, model, and fast-mode arguments without reordering", () => {
    for (const value of [undefined, "", "gpt-5.4", "xhigh", 'quoted "value"', "line\nbreak"]) {
      expect(buildCodexEffortArgs(value)).toEqual(sharedBuildCodexEffortArgs(value))
      expect(buildCodexModelArgs(value)).toEqual(sharedBuildCodexModelArgs(value))
    }
    for (const enabled of [undefined, false, true]) {
      expect(buildCodexFastModeArgs(enabled)).toEqual(sharedBuildCodexFastModeArgs(enabled))
    }
  })

  it("delegates Codex directory detection and codecs", () => {
    for (const cwd of ["/tmp/project", "/tmp/project with spaces", "/home/用户/项目", "C:\\work\\repo\\"]) {
      const encoded = encodeCodexDirName(cwd)
      expect(encoded).toBe(sharedEncodeCodexDirName(cwd))
      expect(decodeCodexDirName(encoded)).toBe(sharedDecodeCodexDirName(encoded))
      expect(isCodexDirName(encoded)).toBe(sharedIsCodexDirName(encoded))
    }
  })
})
