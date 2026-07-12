import { describe, expect, it } from "vitest"
import { settingsApplyRequiresRestart } from "@/hooks/useAppHandlers"

describe("settingsApplyRequiresRestart", () => {
  it("keeps an active native Codex turn running", () => {
    expect(settingsApplyRequiresRestart({
      dirName: "codex__L3RtcC9wcm9qZWN0",
      fileName: "rollout.jsonl",
      rawText: "",
      agentKind: "codex",
    })).toBe(false)
  })

  it("keeps Claude alive because the SDK applies settings over its control channel", () => {
    expect(settingsApplyRequiresRestart({
      dirName: "-tmp-project",
      fileName: "session.jsonl",
      rawText: "",
      agentKind: "claude",
    })).toBe(false)
  })
})
