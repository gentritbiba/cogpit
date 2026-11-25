import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  codeModeAvailable,
  codeModeTerminalStatus,
  registerCodeModeRunner,
  rememberCodeModeSession,
  resumeInCodeMode,
  setCodeModeEnabled,
  startCodeModeSession,
  startsInCodeMode,
  useCanRunCodeMode,
  useIsCodeModeSession,
  type CodeModeRunner,
} from "@/lib/agents/codeMode"
import { instanceDirName, instanceSessionId } from "../../../shared/session/instances"
import { ALL_CAPABILITIES } from "../../../shared/contracts/identity"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"

const PROJECT = "-Users-me-project"

function runner(ready = true) {
  return {
    ready,
    start: vi.fn<CodeModeRunner["start"]>(),
    show: vi.fn<CodeModeRunner["show"]>(() => true),
    status: vi.fn<CodeModeRunner["status"]>(() => "running"),
  }
}

let unregister: (() => void) | null = null

// Known to the server, turned off: what a test turns on, it says.
beforeEach(() => setCodeModeEnabled("local", false))

afterEach(() => {
  unregister?.()
  unregister = null
  setCodeModeEnabled("local", false)
  setCodeModeEnabled("box", false)
  window.history.replaceState(null, "", "/")
})

describe("starting sessions in Code Mode", () => {
  it("needs the setting, an agent with Code Mode and a terminal to run it in", () => {
    expect(startsInCodeMode("claude", PROJECT)).toBe(false)
    setCodeModeEnabled("local", true)
    expect(startsInCodeMode("claude", PROJECT)).toBe(false)
    unregister = registerCodeModeRunner("local", runner())
    expect(startsInCodeMode("claude", PROJECT)).toBe(true)
    expect(startsInCodeMode("codex", PROJECT)).toBe(false)
    setCodeModeEnabled("local", false)
    expect(startsInCodeMode("claude", PROJECT)).toBe(false)
  })

  it("follows the setting and the terminal panel of the machine on screen", () => {
    const local = runner()
    const box = runner()
    unregister = registerCodeModeRunner("local", local)
    const unregisterBox = registerCodeModeRunner("box", box)
    setCodeModeEnabled("box", true)
    expect(startsInCodeMode("claude", PROJECT)).toBe(false)
    window.history.replaceState(null, "", "/d/box/")
    expect(startsInCodeMode("claude", PROJECT)).toBe(true)

    expect(resumeInCodeMode("claude", "on-box", "/srv/project")).toBe(true)
    expect(box.start).toHaveBeenCalledOnce()
    expect(local.start).not.toHaveBeenCalled()
    unregisterBox()
  })

  it("is meant only for a server that leaves each session to its one owner", () => {
    setCodeModeEnabled("local", true)
    unregister = registerCodeModeRunner("local", runner())
    setMe({ authenticated: true, edition: "team", user: { id: "u", username: "me", displayName: "Me" }, capabilities: ALL_CAPABILITIES, enforcesSessionAccess: true })
    expect(startsInCodeMode("claude", PROJECT)).toBe(false)
    __resetCapabilitiesForTest()
    expect(startsInCodeMode("claude", PROJECT)).toBe(true)
  })

  it("offers nothing on a server too old to know Code Mode", () => {
    setCodeModeEnabled("local", null)
    const panel = runner()
    unregister = registerCodeModeRunner("local", panel)
    expect(codeModeAvailable("claude", "5b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d")).toBe(false)
    expect(resumeInCodeMode("claude", "old-server", "/project")).toBe(false)
    expect(panel.start).not.toHaveBeenCalled()
  })

  it("keeps a provider-account instance's sessions out, since the terminal would carry the server's credentials", () => {
    setCodeModeEnabled("local", true)
    const panel = runner()
    unregister = registerCodeModeRunner("local", panel)
    expect(startsInCodeMode("claude", instanceDirName("work", PROJECT))).toBe(false)

    const sessionId = instanceSessionId("work", "5b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d")
    expect(codeModeAvailable("claude", sessionId)).toBe(false)
    expect(codeModeAvailable("claude", "i-work__a")).toBe(false)
    expect(resumeInCodeMode("claude", sessionId, "/project")).toBe(false)
    expect(panel.start).not.toHaveBeenCalled()
  })

  it("hands a launch to the terminal and remembers the session as a Code Mode one", () => {
    const panel = runner()
    const launch = { kind: "claude" as const, sessionId: "started-1", resume: false, cwd: "/project", prompt: "hi" }
    expect(startCodeModeSession(launch)).toBe(false)

    unregister = registerCodeModeRunner("local", panel)
    const { result } = renderHook(() => useIsCodeModeSession("started-1"))
    expect(result.current).toBe(false)
    act(() => { startCodeModeSession(launch) })
    expect(panel.start).toHaveBeenCalledWith(launch)
    expect(result.current).toBe(true)
  })

  it("resumes a session in its folder", () => {
    const panel = runner()
    unregister = registerCodeModeRunner("local", panel)
    expect(resumeInCodeMode("claude", "resumed-1", "/Users/me/project")).toBe(true)
    expect(panel.start).toHaveBeenCalledWith({ kind: "claude", sessionId: "resumed-1", resume: true, cwd: "/Users/me/project" })
  })

  it("reports the terminal only while the panel is connected", () => {
    const { result } = renderHook(() => useCanRunCodeMode())
    expect(result.current).toBe(false)
    expect(codeModeTerminalStatus("s")).toBe("unavailable")

    const reconnecting = runner(false)
    act(() => { unregister = registerCodeModeRunner("local", reconnecting) })
    expect(result.current).toBe(false)
    expect(codeModeTerminalStatus("s")).toBe("unavailable")
    expect(startCodeModeSession({ kind: "claude", sessionId: "s", resume: true, cwd: "/p" })).toBe(false)

    const panel = runner()
    act(() => { unregister = registerCodeModeRunner("local", panel) })
    expect(result.current).toBe(true)
    expect(codeModeTerminalStatus("s")).toBe("running")
    expect(panel.status).toHaveBeenCalledWith("s")
  })
})

describe("remembered Code Mode sessions", () => {
  it("survive a reload of the page's memory", () => {
    rememberCodeModeSession("kept-1")
    expect(JSON.parse(localStorage.getItem("cogpit:code-mode-sessions") ?? "[]")).toContain("kept-1")
    const { result } = renderHook(() => useIsCodeModeSession("kept-1"))
    expect(result.current).toBe(true)
    expect(renderHook(() => useIsCodeModeSession(null)).result.current).toBe(false)
  })
})
