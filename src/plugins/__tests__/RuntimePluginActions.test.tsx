import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseManifest } from "@cogpit/plugin-contracts"
import { RuntimePluginActions } from "../RuntimePluginActions"

const state = vi.hoisted(() => ({ runtime: null as unknown, session: { session: { sessionId: "session-one" }, permissions: { send: true } }, send: vi.fn<(...args: unknown[]) => Promise<boolean>>() }))
vi.mock("../RuntimePluginContributions", () => ({ useRuntimeContributions: () => state.runtime }))
vi.mock("@/contexts/SessionContext", () => ({ useSessionContextOptional: () => state.session, useSessionChatContextOptional: () => ({ chat: { sendMessage: state.send } }) }))
vi.mock("../runtimeClient", () => ({ clientRuntimeDescriptor: () => ({ appVersion: "3.3.6", apiVersions: ["1.2.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, browser: [] }) }))
const manifest = parseManifest({ manifestVersion: 1, id: "example.speech", publisher: "example", name: "Speech", version: "1.0.0", runtime: "browser-iife-v1", engines: { pluginApi: "^1.2.0", client: "*", host: "*" }, requires: { client: {}, host: {} }, permissions: {}, stateVersion: 1,
  contributes: { skills: [{ id: "speech", title: "Speech", description: "Speak", source: "SKILL.md" }], sessionActions: [{ id: "summary", title: "Spoken summary", skill: "speech", prompt: "Summarize this conversation in short spoken prose." }] } })
function runtime(enabled = true, plugin = manifest) { return { activation: "host-one", status: { safeMode: false, runtime: { appVersion: "3.3.6", apiVersions: ["1.2.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, platform: "linux", registryRevision: 1 }, store: { available: true, plugins: [{ id: plugin.id, manifest: plugin, enabled, scope: { type: "all" } }] } }, project: null } }
beforeEach(() => { state.runtime = runtime(); state.session.permissions.send = true; state.session.session.sessionId = "session-one"; state.send.mockReset().mockResolvedValue(true) })
afterEach(() => { state.runtime = null })
describe("plugin session actions", () => {
  it("sends a declared skill prompt only when the user clicks", async () => {
    render(<RuntimePluginActions />)
    expect(state.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Spoken summary" }))
    await waitFor(() => expect(state.send).toHaveBeenCalledExactlyOnceWith("Summarize this conversation in short spoken prose."))
  })
  it("prevents repeated clicks and handles a refused delivery", async () => {
    let finish!: (value: boolean) => void
    state.send.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<RuntimePluginActions />)
    const button = screen.getByRole("button", { name: "Spoken summary" })
    fireEvent.click(button); fireEvent.click(button)
    expect(state.send).toHaveBeenCalledOnce()
    finish(false)
    await screen.findByRole("alert")
  })
  it("hides controls without a plugin host or send permission, or after disable", () => {
    state.runtime = null
    const view = render(<RuntimePluginActions />)
    expect(screen.queryByRole("button")).toBeNull()
    state.runtime = runtime(false); view.rerender(<RuntimePluginActions />)
    expect(screen.queryByRole("button")).toBeNull()
    state.runtime = runtime(); state.session.permissions.send = false; view.rerender(<RuntimePluginActions />)
    expect(screen.queryByRole("button")).toBeNull()
  })
  it("draws a compact icon button with the action's name when the action declares an icon", async () => {
    state.runtime = runtime(true, parseManifest({ ...manifest, contributes: { ...manifest.contributes, sessionActions: manifest.contributes.sessionActions!.map(action => ({ ...action, icon: "speaker" })) } }))
    render(<RuntimePluginActions />)
    const button = screen.getByRole("button", { name: "Spoken summary" })
    expect(button).not.toHaveTextContent("Spoken summary")
    expect(button.querySelector("svg")).not.toBeNull()
    fireEvent.click(button)
    await waitFor(() => expect(state.send).toHaveBeenCalledOnce())
  })
})
