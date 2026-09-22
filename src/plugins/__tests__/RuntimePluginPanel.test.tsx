import { act, render, screen, waitFor } from "@testing-library/react"
import { StrictMode, useLayoutEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PluginFrameProps } from "../PluginFrame"
import { RuntimePluginPanel, type RuntimePluginPanelProps } from "../RuntimePluginPanel"
import { panelPlugin, panelProject, panelWorkspace } from "./runtimePanelFixtures"
import { pluginPanelContext, readPluginPresentation } from "../runtimeContext"
import type { RuntimePanelClient } from "../runtimePanelActivation"
import { setBrowserSafeMode } from "../browserSafeMode"

const frame = vi.hoisted(() => ({ current: null as PluginFrameProps | null }))
vi.mock("../PluginFrame", () => ({ PluginFrame: (props: PluginFrameProps) => {
  const { activationKey, payload, onDispose } = props
  useLayoutEffect(() => () => onDispose?.(), [activationKey, payload, onDispose])
  if (props.active) frame.current = props
  return <div data-testid="plugin-frame" />
} }))
function setup(overrides: Partial<RuntimePluginPanelProps> = {}, strict = false, extras: Partial<Pick<RuntimePanelClient, "resolveSession" | "sessionHandle">> = {}) {
  const client = { lease: vi.fn<RuntimePanelClient["lease"]>(async () => ({ id: "lease-1", expiresAt: Date.now() + 30_000 })), payload: vi.fn(async () => new ArrayBuffer(2)),
    renewLease: vi.fn(async () => ({ id: "lease-1", expiresAt: Date.now() + 30_000 })), revokeLease: vi.fn(async () => {}), call: vi.fn(async () => null), ...extras }
  const props: RuntimePluginPanelProps = { client, plugin: panelPlugin, activation: "host-session-1", registryRevision: 1, project: panelProject,
    context: panelWorkspace, active: true, closePanel: vi.fn(), ...overrides }
  const element = <RuntimePluginPanel {...props} />
  return { client, props, ...render(strict ? <StrictMode>{element}</StrictMode> : element) }
}
afterEach(() => { window.history.replaceState(null, "", "/"); document.documentElement.removeAttribute("style"); document.documentElement.classList.remove("dark"); frame.current = null })

describe("installed runtime panel", () => {
  it("loads with an opaque epoch and exposes only granted project identity", async () => {
    const value = setup()
    await screen.findByTestId("plugin-frame")
    expect(value.client.lease).toHaveBeenCalledWith(panelPlugin.id, panelProject.id, expect.stringMatching(/^[a-f0-9]{32}$/), expect.any(AbortSignal), "/private/repo")
    expect(frame.current?.context.project).toBeNull()
    expect(JSON.stringify(frame.current?.context)).not.toContain("/private/repo")
    expect(JSON.stringify(frame.current?.context)).not.toContain("host-session")
    value.unmount()
    expect(value.client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
  })
  it("allows a global panel to load when the current cwd is outside plugin inventory", async () => {
    const value = setup({ project: null, context: { ...panelWorkspace, projectPath: "/unknown/workspace" } })
    await screen.findByTestId("plugin-frame")
    expect(value.client.lease).toHaveBeenCalledWith(panelPlugin.id, null, expect.any(String), expect.any(AbortSignal), null)
    expect(frame.current?.context.project).toBeNull()
  })
  it.each(["activation", "registry"] as const)("revokes and reloads when the %s epoch changes", async (change) => {
    const value = setup(); await screen.findByTestId("plugin-frame")
    const before = value.client.lease.mock.calls[0]
    const props = { ...value.props }
    if (change === "activation") props.activation = "host-session-2"
    if (change === "registry") props.registryRevision = 2
    value.rerender(<RuntimePluginPanel {...props} />)
    await waitFor(() => expect(value.client.lease).toHaveBeenCalledTimes(2))
    expect(value.client.revokeLease).toHaveBeenCalledWith("lease-1")
    expect(value.client.lease.mock.calls[1][2]).not.toBe(before[2])
  })
  it("retains three project panels, restores the same activation, and revokes the least recently used entry", async () => {
    const value = setup(); await screen.findByTestId("plugin-frame")
    const original = frame.current!.activationKey
    const visit = async (index: number) => {
      value.rerender(<RuntimePluginPanel {...value.props} project={{ ...panelProject, id: `project-${index}` }} context={{ ...panelWorkspace, projectPath: `/project-${index}` }} />)
      await waitFor(() => expect(frame.current?.active).toBe(true))
    }
    await visit(1); await waitFor(() => expect(value.client.lease).toHaveBeenCalledTimes(2))
    await visit(2); await waitFor(() => expect(value.client.lease).toHaveBeenCalledTimes(3))
    const order = screen.getAllByTestId("plugin-frame")
    value.rerender(<RuntimePluginPanel {...value.props} />)
    expect(screen.getAllByTestId("plugin-frame")).toEqual(order)
    expect(frame.current!.activationKey).toBe(original)
    expect(value.client.lease).toHaveBeenCalledTimes(3)
    expect(value.client.revokeLease).not.toHaveBeenCalled()
    await visit(3); await waitFor(() => expect(value.client.lease).toHaveBeenCalledTimes(4))
    expect(value.client.revokeLease).toHaveBeenCalledTimes(1)
    expect(screen.getAllByTestId("plugin-frame")).toHaveLength(3)
    value.rerender(<RuntimePluginPanel {...value.props} activation="different-host-session" />)
    await waitFor(() => expect(value.client.lease).toHaveBeenCalledTimes(5))
    expect(value.client.revokeLease).toHaveBeenCalledTimes(4)
    expect(screen.getAllByTestId("plugin-frame")).toHaveLength(1)
  })
  it("names the open session to a plugin granted session identity, by handle only", async () => {
    const handle = `s_${"c".repeat(48)}`
    const sessionHandle = vi.fn(async () => handle)
    const manifest = { ...panelPlugin.manifest, permissions: { ...panelPlugin.manifest.permissions, context: ["session.identity" as const] } }
    const address = { dirName: "-private-repo", fileName: "session-a.jsonl" }
    const value = setup({ plugin: { ...panelPlugin, manifest }, context: { ...panelWorkspace, sessionAddress: address } }, false, { sessionHandle })
    await screen.findByTestId("plugin-frame")
    await waitFor(() => expect(frame.current?.context.session).toEqual({ handle }))
    expect(sessionHandle).toHaveBeenCalledWith("lease-1", address, expect.any(AbortSignal))
    expect(JSON.stringify(frame.current?.context)).not.toContain("session-a.jsonl")
    value.rerender(<RuntimePluginPanel {...value.props} context={{ ...panelWorkspace, sessionAddress: null }} />)
    await waitFor(() => expect(frame.current?.context.session).toBeNull())
    expect(sessionHandle).toHaveBeenCalledTimes(1)
  })
  it("does not name the open session to a plugin without session identity", async () => {
    const sessionHandle = vi.fn(async () => `s_${"c".repeat(48)}`)
    setup({ context: { ...panelWorkspace, sessionAddress: { dirName: "-private-repo", fileName: "session-a.jsonl" } } }, false, { sessionHandle })
    await screen.findByTestId("plugin-frame")
    expect(frame.current?.context).not.toHaveProperty("session")
    expect(sessionHandle).not.toHaveBeenCalled()
  })
  it("keeps the loaded panel when switching sessions within the same workspace", async () => {
    const value = setup(); await screen.findByTestId("plugin-frame")
    const key = frame.current!.activationKey
    value.rerender(<RuntimePluginPanel {...value.props} context={{ ...panelWorkspace, sessionChangeKey: 2 }} />)
    expect(frame.current!.activationKey).toBe(key)
    expect(value.client.lease).toHaveBeenCalledTimes(1)
    expect(value.client.payload).toHaveBeenCalledTimes(1)
    expect(value.client.revokeLease).not.toHaveBeenCalled()
  })
  it("suspends a hidden panel and revokes its lease on frame navigation", async () => {
    const value = setup(); await screen.findByTestId("plugin-frame")
    value.rerender(<RuntimePluginPanel {...value.props} active={false} />)
    await expect(frame.current!.execute({ protocol: 1, type: "request", id: "r1", method: "storage.get", params: { key: "setting" } }, new AbortController().signal)).rejects.toThrow("hidden")
    expect(value.client.call).not.toHaveBeenCalled()
    act(() => frame.current!.onError?.(new Error("Plugin frame navigated or reloaded")))
    expect(screen.getByRole("alert")).toHaveTextContent("Plugin frame navigated or reloaded")
    expect(value.client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
  })
  it("does not load frames or leases in URL safe mode", () => {
    window.history.replaceState(null, "", "/?pluginSafeMode=1")
    const value = setup()
    expect(value.client.lease).not.toHaveBeenCalled()
    expect(screen.queryByTestId("plugin-frame")).not.toBeInTheDocument()
  })
  it("revokes a running panel when browser safe mode changes and starts a fresh activation on resume", async () => {
    const value = setup()
    await screen.findByTestId("plugin-frame")
    act(() => setBrowserSafeMode(true))
    expect(screen.queryByTestId("plugin-frame")).not.toBeInTheDocument()
    expect(value.client.revokeLease).toHaveBeenCalledExactlyOnceWith("lease-1")
    act(() => setBrowserSafeMode(false))
    await screen.findByTestId("plugin-frame")
    expect(value.client.lease).toHaveBeenCalledTimes(2)
  })
  it("keeps the live activation through StrictMode's frame cleanup cycle", async () => {
    const value = setup({}, true)
    await screen.findByTestId("plugin-frame")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(value.client.lease).toHaveBeenCalledTimes(2)
    expect(value.client.revokeLease).toHaveBeenCalledTimes(1)
    await expect(frame.current!.execute({ protocol: 1, type: "request", id: "r1", method: "lifecycle.ready", params: {} }, new AbortController().signal)).resolves.toBeNull()
    value.unmount()
    expect(value.client.revokeLease).toHaveBeenCalledTimes(2)
  })
})

describe("plugin presentation context", () => {
  it("copies named theme tokens and reduced motion without arbitrary host variables", () => {
    document.documentElement.classList.add("dark")
    document.documentElement.style.setProperty("--background", "black")
    document.documentElement.style.setProperty("--host-private", "secret")
    const presentation = readPluginPresentation()
    expect(presentation.theme).toEqual({ mode: "dark", tokens: { "--background": "black" } })
    expect(presentation.locale).toBeTruthy()
    expect(typeof presentation.reducedMotion).toBe("boolean")
    const manifest = { ...panelPlugin.manifest, permissions: { ...panelPlugin.manifest.permissions, context: ["project.identity" as const] } }
    expect(pluginPanelContext(manifest, { ...panelProject, name: "\nExample\t" }, true, presentation).project).toEqual({ id: panelProject.id, name: "Example" })
    expect(pluginPanelContext(manifest, { ...panelProject, name: `${"x".repeat(127)}😀` }, true, presentation).project?.name).toBe("x".repeat(127))
    expect(pluginPanelContext(manifest, null, false, presentation).project).toBeNull()
  })
})
