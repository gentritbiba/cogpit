import { StrictMode, useLayoutEffect } from "react"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PluginInstallPreview } from "../../../shared/contracts/plugins"
import type { PluginFrameProps } from "../PluginFrame"
import type { RuntimePluginClient } from "../runtimeClient"
import { PluginInstallTrial } from "../PluginInstallTrial"
import { panelManifest } from "./runtimePanelFixtures"

const frame = vi.hoisted(() => ({ current: null as PluginFrameProps | null }))
vi.mock("../PluginFrame", () => ({ PluginFrame: (props: PluginFrameProps) => {
  const { activationKey, payload, onDispose } = props
  useLayoutEffect(() => () => onDispose?.(), [activationKey, payload, onDispose])
  frame.current = props
  return <div data-testid="trial-frame" />
} }))
const preview: PluginInstallPreview = { transactionId: "0743cefc-34a4-432f-a9d2-d887bb480af2", manifest: panelManifest,
  digest: "a".repeat(64), oldVersion: null, registryRevision: 1, publisherKind: "development", scope: { type: "all" }, connectionDefinitions: [],
  compatibility: { compatible: true, apiVersion: "1.0.0", issues: [], unavailableOptional: [] } }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function setup(options: { strict?: boolean; payload?: Promise<ArrayBuffer>; commit?: Promise<void>; begin?: Promise<number>; refresh?: Promise<void> } = {}) {
  const client = {
    payload: vi.fn<RuntimePluginClient["payload"]>(async () => options.payload ?? new ArrayBuffer(2)),
    beginTrial: vi.fn(async (_preview: PluginInstallPreview, _signal?: AbortSignal) => options.begin ?? Date.now() + 10_000),
    commit: vi.fn(async (_preview: PluginInstallPreview, _signal?: AbortSignal) => options.commit),
    cancel: vi.fn(async () => {}),
    refresh: vi.fn(async () => options.refresh),
    transactionOutcome: vi.fn<RuntimePluginClient["transactionOutcome"]>(async () => ({ status: "committed", preview })),
  }
  const callbacks = { onComplete: vi.fn(), onError: vi.fn() }
  const props = { client: client as unknown as RuntimePluginClient, preview, activation: "host-session-1", ...callbacks }
  const element = <PluginInstallTrial {...props} />
  return { client, props, ...callbacks, ...render(options.strict ? <StrictMode>{element}</StrictMode> : element) }
}
afterEach(() => { cleanup(); frame.current = null; vi.useRealTimers() })

describe("provisional installation coordinator", () => {
  it("fetches bytes before starting the trial and supplies no project or provider access", async () => {
    const bytes = deferred<ArrayBuffer>(), value = setup({ payload: bytes.promise })
    expect(value.client.beginTrial).not.toHaveBeenCalled()
    expect(screen.queryByTestId("trial-frame")).not.toBeInTheDocument()
    await act(async () => bytes.resolve(new ArrayBuffer(2)))
    await screen.findByTestId("trial-frame")
    expect(value.client.beginTrial).toHaveBeenCalledOnce()
    expect(frame.current?.context.project).toBeNull()
    expect(frame.current?.active).toBe(false)
    const signal = new AbortController().signal
    await expect(frame.current!.execute({ protocol: 1, type: "request", id: "r1", method: "lifecycle.ready", params: {} }, signal)).resolves.toBeNull()
    await expect(frame.current!.execute({ protocol: 1, type: "request", id: "r2", method: "storage.get", params: { key: "setting" } }, signal)).rejects.toThrow()
  })
  it("performs one trial and one commit under StrictMode and duplicate readiness", async () => {
    const committing = deferred<void>(), value = setup({ strict: true, commit: committing.promise })
    await screen.findByTestId("trial-frame")
    expect(value.client.payload).toHaveBeenCalledTimes(2)
    expect(value.client.payload.mock.calls[0][1]?.aborted).toBe(true)
    expect(value.client.beginTrial).toHaveBeenCalledOnce()
    act(() => { frame.current!.onReady?.(); frame.current!.onReady?.() })
    expect(value.client.commit).toHaveBeenCalledOnce()
    await act(async () => committing.resolve())
    expect(value.onComplete).toHaveBeenCalledOnce()
    expect(value.onError).not.toHaveBeenCalled()
  })
  it("ignores payload completion after coordinator unmount", async () => {
    const bytes = deferred<ArrayBuffer>(), value = setup({ payload: bytes.promise })
    value.unmount()
    expect(value.client.payload.mock.calls[0][1]?.aborted).toBe(true)
    await act(async () => bytes.resolve(new ArrayBuffer(2)))
    expect(value.client.beginTrial).not.toHaveBeenCalled()
    expect(value.onComplete).not.toHaveBeenCalled()
    expect(value.onError).not.toHaveBeenCalled()
  })
  it("aborts a pending commit and ignores its completion after unmount", async () => {
    const committing = deferred<void>(), value = setup({ commit: committing.promise })
    await screen.findByTestId("trial-frame")
    act(() => frame.current!.onReady?.())
    value.unmount()
    expect(value.client.commit.mock.calls[0][1]?.aborted).toBe(true)
    await act(async () => committing.resolve())
    expect(value.onComplete).not.toHaveBeenCalled()
    expect(value.onError).not.toHaveBeenCalled()
  })
  it("aborts pending trial setup when activation changes", async () => {
    const begun = deferred<number>(), value = setup({ begin: begun.promise })
    await waitFor(() => expect(value.client.beginTrial).toHaveBeenCalledOnce())
    value.rerender(<PluginInstallTrial {...value.props} activation="" />)
    expect(value.client.beginTrial.mock.calls[0][1]?.aborted).toBe(true)
    await act(async () => begun.resolve(Date.now() + 10_000))
    expect(screen.queryByTestId("trial-frame")).not.toBeInTheDocument()
    expect(value.client.commit).not.toHaveBeenCalled()
  })
  it("aborts pending commit when the provisional frame fails", async () => {
    const committing = deferred<void>(), value = setup({ commit: committing.promise })
    await screen.findByTestId("trial-frame")
    act(() => frame.current!.onReady?.())
    act(() => frame.current!.onError?.(new Error("Plugin frame navigated")))
    expect(value.client.commit.mock.calls[0][1]?.aborted).toBe(true)
    await act(async () => committing.resolve())
    expect(value.onComplete).not.toHaveBeenCalled()
    expect(value.onError).toHaveBeenCalledOnce()
  })
  it("ignores readiness and errors from an invalidated frame", async () => {
    const value = setup(); await screen.findByTestId("trial-frame")
    const previous = frame.current!
    value.rerender(<PluginInstallTrial {...value.props} activation="" />)
    act(() => { previous.onReady?.(); previous.onError?.(new Error("late frame error")) })
    expect(value.client.commit).not.toHaveBeenCalled()
    expect(value.onError).not.toHaveBeenCalled()
    expect(screen.queryByTestId("trial-frame")).not.toBeInTheDocument()
  })
  it("reconciles a lost commit response with the persisted transaction outcome", async () => {
    const committing = deferred<void>(), value = setup({ commit: committing.promise })
    await screen.findByTestId("trial-frame")
    act(() => frame.current!.onReady?.())
    await act(async () => committing.reject(new Error("lost response")))
    expect(value.client.transactionOutcome).toHaveBeenCalledExactlyOnceWith(preview)
    expect(value.client.refresh).toHaveBeenCalledOnce()
    expect(value.onComplete).toHaveBeenCalledOnce()
    expect(value.onError).not.toHaveBeenCalled()
    expect(value.client.commit).toHaveBeenCalledOnce()
  })
  it("does not claim success when the persisted outcome remains uncommitted", async () => {
    const committing = deferred<void>(), value = setup({ commit: committing.promise })
    value.client.transactionOutcome.mockResolvedValue({ status: "cancelled", preview })
    await screen.findByTestId("trial-frame")
    act(() => frame.current!.onReady?.())
    await act(async () => committing.reject(new Error("commit was rejected")))
    expect(value.onComplete).not.toHaveBeenCalled()
    expect(value.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "commit was rejected" }))
  })
  it("reports an unknown outcome without retrying the commit", async () => {
    const committing = deferred<void>(), value = setup({ commit: committing.promise })
    value.client.transactionOutcome.mockRejectedValue(new Error("offline"))
    await screen.findByTestId("trial-frame")
    act(() => frame.current!.onReady?.())
    await act(async () => committing.reject(new Error("lost response")))
    expect(value.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Check Installed after reconnecting") }))
    expect(value.onComplete).not.toHaveBeenCalled()
    expect(value.client.commit).toHaveBeenCalledOnce()
  })
  it("does not complete after unmount while recovered state is being refreshed", async () => {
    const committing = deferred<void>(), refreshing = deferred<void>(), value = setup({ commit: committing.promise, refresh: refreshing.promise })
    await screen.findByTestId("trial-frame")
    act(() => frame.current!.onReady?.())
    await act(async () => committing.reject(new Error("lost response")))
    expect(value.client.refresh).toHaveBeenCalledOnce()
    value.unmount()
    await act(async () => refreshing.resolve())
    expect(value.onComplete).not.toHaveBeenCalled()
    expect(value.onError).not.toHaveBeenCalled()
  })
  it("uses the host deadline instead of granting a new local ten-second window", async () => {
    vi.useFakeTimers()
    const value = setup({ begin: Promise.resolve(Date.now() + 1000) })
    await act(async () => {})
    expect(screen.getByTestId("trial-frame")).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(999))
    expect(value.onError).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(value.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("expired") }))
    expect(screen.queryByTestId("trial-frame")).not.toBeInTheDocument()
    expect(value.client.commit).not.toHaveBeenCalled()
  })
  it("removes the trial deadline when its coordinator unmounts", async () => {
    vi.useFakeTimers()
    const value = setup({ begin: Promise.resolve(Date.now() + 1000) })
    await act(async () => {})
    value.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(value.onError).not.toHaveBeenCalled()
    expect(value.onComplete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("never mounts a frame when the begin-trial response arrives after expiry", async () => {
    const value = setup({ begin: Promise.resolve(Date.now() - 1) })
    await waitFor(() => expect(value.onError).toHaveBeenCalledOnce())
    expect(screen.queryByTestId("trial-frame")).not.toBeInTheDocument()
    expect(value.client.commit).not.toHaveBeenCalled()
  })
  it("aborts an overdue commit and reconciles a promotion completed before its deadline", async () => {
    vi.useFakeTimers()
    const committing = deferred<void>(), value = setup({ begin: Promise.resolve(Date.now() + 1000), commit: committing.promise })
    await act(async () => {})
    act(() => frame.current!.onReady?.())
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(value.client.commit.mock.calls[0][1]?.aborted).toBe(true)
    expect(value.client.transactionOutcome).toHaveBeenCalledOnce()
    expect(value.onComplete).toHaveBeenCalledOnce()
    expect(value.onError).not.toHaveBeenCalled()
    await act(async () => committing.resolve())
    expect(value.onComplete).toHaveBeenCalledOnce()
  })
  it("rejects readiness which arrives past the deadline before the timer callback runs", async () => {
    vi.useFakeTimers()
    const deadline = Date.now() + 1000, value = setup({ begin: Promise.resolve(deadline) })
    await act(async () => {})
    vi.setSystemTime(deadline + 1)
    act(() => frame.current!.onReady?.())
    expect(value.onError).toHaveBeenCalledOnce()
    expect(value.client.commit).not.toHaveBeenCalled()
  })
})
