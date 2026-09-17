import { StrictMode, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useRuntimeProject } from "../useRuntimeProject"
import { PluginsDialog } from "../PluginsDialog"
import type { RuntimePluginClient } from "../runtimeClient"
import { panelHostStatus, panelManifest, panelProject } from "./runtimePanelFixtures"

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const props = { status: panelHostStatus, activation: "host-a", projectPath: "/symlink/repo" }
afterEach(cleanup)

describe("host-resolved runtime project selection", () => {
  it("keeps canonical lexical matches immediate and resolves unknown symlink paths on the host", async () => {
    const client = { resolveWorkspace: vi.fn().mockResolvedValue(panelProject) }
    const { result, rerender } = renderHook(value => useRuntimeProject({ ...value, client }), { initialProps: { ...props, projectPath: "/private/repo/src" } })
    expect(result.current).toEqual({ project: panelProject, resolving: false })
    expect(client.resolveWorkspace).not.toHaveBeenCalled()
    rerender(props)
    expect(result.current).toEqual({ project: null, resolving: true })
    await waitFor(() => expect(result.current).toEqual({ project: panelProject, resolving: false }))
    expect(client.resolveWorkspace).toHaveBeenCalledExactlyOnceWith("/symlink/repo", expect.any(AbortSignal))
  })

  it.each(["host", "path", "registry"] as const)("never displays a stale project after the %s changes", async change => {
    const first = deferred<typeof panelProject | null>(), second = deferred<typeof panelProject | null>()
    const client = { resolveWorkspace: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) }
    const { result, rerender } = renderHook(value => useRuntimeProject({ ...value, client }), { initialProps: props })
    await waitFor(() => expect(client.resolveWorkspace).toHaveBeenCalledTimes(1))
    await act(async () => { first.resolve(panelProject) })
    expect(result.current.project).toBe(panelProject)
    rerender({ ...props, ...(change === "host" ? { activation: "host-b" } : change === "path" ? { projectPath: "/another/alias" } : { status: { ...panelHostStatus, store: { ...panelHostStatus.store, revision: 2 } } }) })
    expect(result.current).toEqual({ project: null, resolving: true })
    expect(client.resolveWorkspace.mock.calls[0][1].aborted).toBe(true)
    await waitFor(() => expect(client.resolveWorkspace).toHaveBeenCalledTimes(2))
    await act(async () => { second.resolve(null) })
    expect(result.current).toEqual({ project: null, resolving: false })
  })

  it("ignores a late alias response after switching to a newer workspace request", async () => {
    const old = deferred<typeof panelProject | null>(), current = deferred<typeof panelProject | null>()
    const client = { resolveWorkspace: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise) }
    const { result, rerender } = renderHook(value => useRuntimeProject({ ...value, client }), { initialProps: props })
    await waitFor(() => expect(client.resolveWorkspace).toHaveBeenCalledTimes(1))
    rerender({ ...props, projectPath: "/new/alias" })
    await waitFor(() => expect(client.resolveWorkspace).toHaveBeenCalledTimes(2))
    await act(async () => { old.resolve(panelProject) })
    expect(result.current).toEqual({ project: null, resolving: true })
    await act(async () => { current.resolve(null) })
    expect(result.current).toEqual({ project: null, resolving: false })
  })

  it("clears resolution on unmount, host unavailability and request failure", async () => {
    const pending = deferred<typeof panelProject | null>(), client = { resolveWorkspace: vi.fn().mockReturnValue(pending.promise) }
    const { result, rerender, unmount } = renderHook(value => useRuntimeProject({ ...value, client }), { initialProps: props })
    await waitFor(() => expect(client.resolveWorkspace).toHaveBeenCalledTimes(1))
    rerender({ ...props, activation: "" })
    expect(result.current).toEqual({ project: null, resolving: false })
    expect(client.resolveWorkspace.mock.calls[0][1].aborted).toBe(true)
    await act(async () => { pending.reject(new Error("old host")) })
    rerender(props)
    await waitFor(() => expect(result.current).toEqual({ project: null, resolving: false }))
    unmount()
    expect(client.resolveWorkspace.mock.calls.at(-1)![1].aborted).toBe(true)
  })

  it("supports StrictMode without publishing its discarded request", async () => {
    const client = { resolveWorkspace: vi.fn().mockResolvedValue(panelProject) }
    const { result, unmount } = renderHook(() => useRuntimeProject({ ...props, client }), { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> })
    await waitFor(() => expect(result.current.project).toBe(panelProject))
    expect(client.resolveWorkspace).toHaveBeenCalledTimes(1)
    unmount()
    expect(client.resolveWorkspace.mock.calls[0][1].aborted).toBe(true)
  })

  it("waits for an alias resolution before reviewing the current project's bundled install", async () => {
    const pending = deferred<typeof panelProject | null>()
    const preview = { transactionId: "fixture", manifest: panelManifest, digest: "a".repeat(64), oldVersion: null, publisherKind: "official", registryRevision: 1,
      compatibility: { compatible: true, apiVersion: "1.0.0", issues: [], unavailableOptional: [] }, scope: { type: "projects", projectIds: [panelProject.id] }, connectionDefinitions: [] }
    const client = { resolveWorkspace: vi.fn().mockReturnValue(pending.promise), stageSeed: vi.fn().mockResolvedValue(preview), cancel: vi.fn().mockResolvedValue(undefined) }
    const state = { status: { ...panelHostStatus, store: { ...panelHostStatus.store, plugins: [], availableSeeds: [{ manifest: panelManifest, digest: preview.digest }] } }, activation: "host-a", error: null }
    render(<PluginsDialog client={client as unknown as RuntimePluginClient} state={state} currentPath="/symlink/repo" onClose={() => {}} />)
    fireEvent.click(screen.getByRole("tab", { name: "Browse" }))
    expect(screen.getByRole("button", { name: "Review installation" })).toBeDisabled()
    await act(async () => { pending.resolve(panelProject) })
    expect(screen.getByRole("button", { name: "Review installation" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Review installation" }))
    await waitFor(() => expect(client.stageSeed).toHaveBeenCalledExactlyOnceWith(panelManifest.id, { type: "projects", projectIds: [panelProject.id] }))
  })
})
