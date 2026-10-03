// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { AppConfig } from "../../config"
import { changedConfigKeys, storedSettings } from "../../lib/configChanges"

const SAVED: AppConfig = {
  claudeDir: "/home/me/.agent",
  networkAccess: true,
  networkPassword: "salt:hash",
  terminalApp: "Ghostty",
  useBuiltInEditor: false,
  agentExecutable: { source: "custom", path: "/opt/bin/agent" },
}

describe("storedSettings", () => {
  it("stores flags as booleans and leaves out blanks and the automatic executable", () => {
    expect(storedSettings({ networkAccess: 1, terminalApp: "", editorApp: "Zed", agentExecutable: { source: "auto" } })).toEqual({
      networkAccess: true,
      terminalApp: undefined,
      editorApp: "Zed",
      useBuiltInEditor: false,
      agentExecutable: undefined,
    })
  })
})

describe("changedConfigKeys", () => {
  it("names the settings a save changed, sorted, and nothing it kept", () => {
    const next: AppConfig = { ...SAVED, networkPassword: "salt2:hash2", terminalApp: undefined, editorApp: "Zed" }

    expect(changedConfigKeys(SAVED, next)).toEqual(["editorApp", "networkPassword", "terminalApp"])
  })

  it("compares a nested setting by value", () => {
    expect(changedConfigKeys(SAVED, { ...SAVED, agentExecutable: { source: "custom", path: "/opt/bin/agent" } })).toEqual([])
    expect(changedConfigKeys(SAVED, { ...SAVED, agentExecutable: { source: "npm" } })).toEqual(["agentExecutable"])
  })

  it("reads a setting a config never stored as its stored default", () => {
    const stored: AppConfig = { claudeDir: "/home/me/.agent" }
    const next: AppConfig = { claudeDir: "/home/me/.agent", ...storedSettings({}) }

    expect(changedConfigKeys(stored, next)).toEqual([])
  })

  it("names what the first save sets beyond the defaults", () => {
    expect(changedConfigKeys(null, { claudeDir: "/home/me/.agent", ...storedSettings({ terminalApp: "Ghostty" }) }))
      .toEqual(["claudeDir", "terminalApp"])
  })
})
