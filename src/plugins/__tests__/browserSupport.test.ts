import { createElement, StrictMode, type ReactNode } from "react"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
vi.mock("@/lib/auth", () => ({ authFetch: vi.fn() }))
import { authFetch } from "@/lib/auth"
import * as browserSupport from "../browserSupport"
import type { PluginBrowserEnvironment } from "../browserSupport"
import { clientRuntimeDescriptor, RuntimePluginClient } from "../runtimeClient"
import { useRuntimePlugins } from "../useRuntimePlugins"

const checkSupport = browserSupport.getPluginBrowserSupport
function environment(): PluginBrowserEnvironment {
  const available = vi.fn()
  return {
    isSecureContext: true, MessageChannel: available,
    MessagePort: { prototype: { postMessage: available, start: available, close: available } },
    Blob: available, URL: { createObjectURL: available, revokeObjectURL: available },
    crypto: { subtle: { digest: available }, getRandomValues: available },
    AbortController: available, AbortSignal: { any: available, timeout: available, prototype: { throwIfAborted: available } },
    structuredClone: available, Object: { hasOwn: available }, fetch: available, Headers: available,
    ReadableStream: { prototype: { getReader: available } }, TextEncoder: available, TextDecoder: available,
  }
}
const cases: Array<[string, (value: PluginBrowserEnvironment) => void]> = [
  ["secure context", value => { value.isSecureContext = false }],
  ["secure context", value => { value.isSecureContext = undefined }],
  ["MessageChannel", value => { value.MessageChannel = undefined }],
  ["MessageChannel", value => { value.MessagePort = null }],
  ["MessageChannel", value => { value.MessagePort!.prototype!.close = undefined }],
  ["MessageChannel", value => { value.MessagePort!.prototype!.start = undefined }],
  ["MessageChannel", value => { value.MessagePort!.prototype!.postMessage = undefined }],
  ["Blob URLs", value => { value.Blob = undefined }],
  ["Blob URLs", value => { value.URL = null }],
  ["Blob URLs", value => { value.URL!.createObjectURL = {} }],
  ["Blob URLs", value => { value.URL!.revokeObjectURL = undefined }],
  ["Web Crypto", value => { value.crypto = null }],
  ["Web Crypto", value => { value.crypto!.subtle = null }],
  ["Web Crypto", value => { value.crypto!.subtle!.digest = {} }],
  ["Web Crypto", value => { value.crypto!.getRandomValues = undefined }],
  ["AbortController", value => { value.AbortController = undefined }],
  ["AbortSignal.any", value => { value.AbortSignal!.any = undefined }],
  ["AbortSignal.timeout", value => { value.AbortSignal!.timeout = undefined }],
  ["AbortSignal.throwIfAborted", value => { value.AbortSignal!.prototype!.throwIfAborted = undefined }],
  ["structuredClone", value => { value.structuredClone = undefined }],
  ["Object.hasOwn", value => { value.Object!.hasOwn = undefined }],
  ["fetch", value => { value.fetch = undefined }],
  ["Headers", value => { value.Headers = undefined }],
  ["ReadableStream", value => { value.ReadableStream!.prototype!.getReader = undefined }],
  ["TextEncoder", value => { value.TextEncoder = undefined }],
  ["TextDecoder", value => { value.TextDecoder = undefined }],
]

describe("runtime plugin browser prerequisites", () => {
  it("checks APIs without allocating channels, invoking crypto, or making requests", () => {
    const value = environment()
    expect(checkSupport(value)).toEqual({ supported: true, browser: ["message-channel", "blob-script", "web-crypto"], missing: [], error: null })
    expect(value.MessageChannel).not.toHaveBeenCalled()
  })

  it.each(cases)("rejects missing or unusable %s", (name, remove) => {
    const value = environment(); remove(value)
    expect(checkSupport(value)).toMatchObject({ supported: false, missing: expect.arrayContaining([expect.stringContaining(name)]), error: expect.stringContaining(name) })
  })

  it("does not advertise partial browser features or insecure Web Crypto", () => {
    const value = environment()
    value.isSecureContext = false; value.MessagePort = null; value.URL!.revokeObjectURL = undefined
    expect(checkSupport(value).browser).toEqual([])
  })
})

describe("unsupported browser plugin startup", () => {
  let value: PluginBrowserEnvironment
  const clients: RuntimePluginClient[] = []
  beforeEach(() => {
    value = environment()
    vi.spyOn(browserSupport, "getPluginBrowserSupport").mockImplementation(() => checkSupport(value))
    vi.mocked(authFetch).mockReset().mockImplementation(async input => {
      const result = new URL(String(input)).pathname.endsWith("/session")
        ? { sessionId: "a".repeat(64), expiresAt: Date.now() + 60_000 }
        : {
            runtime: { appVersion: "2.6.6", apiVersions: ["1.0.0"], manifestVersions: [1], protocolVersions: [1], runtimes: ["browser-iife-v1"], capabilities: {}, platform: "linux", registryRevision: 0 },
            host: { name: "Fixture", instanceId: "host-fixture" }, store: { available: true, revision: 0, plugins: [], publishers: [] }, projects: [], safeMode: false,
          }
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } })
    })
  })
  afterEach(() => {
    cleanup()
    for (const client of clients.splice(0)) client.stop()
    vi.unstubAllGlobals(); vi.restoreAllMocks()
  })
  function client() { const current = new RuntimePluginClient(); clients.push(current); return current }

  it.each(cases)("reports unsupported %s before any host request", async (name, remove) => {
    remove(value)
    const current = client()
    expect(() => current.start()).not.toThrow()
    await current.refresh()
    expect(current.getSnapshot()).toMatchObject({ status: null, activation: "", error: expect.stringContaining(name) })
    await expect(current.stageSeed("cogpit.clickup", { type: "all" })).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" })
    expect(authFetch).not.toHaveBeenCalled()
    expect(clientRuntimeDescriptor()).toMatchObject({ runtimes: [], capabilities: {} })
    expect(() => current.stop()).not.toThrow()
  })

  it("can construct and stop the client when AbortController is absent", () => {
    value.AbortController = undefined
    vi.stubGlobal("AbortController", undefined)
    const current = client()
    expect(() => { current.start(); current.stop() }).not.toThrow()
    expect(authFetch).not.toHaveBeenCalled()
  })

  it("leaves the hook mounted under StrictMode and can start once prerequisites are available", async () => {
    value.isSecureContext = false
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children)
    const { result, rerender } = renderHook(({ enabled }) => useRuntimePlugins(enabled), { initialProps: { enabled: true }, wrapper })
    expect(result.current.error).toContain("secure context")
    expect(authFetch).not.toHaveBeenCalled()
    act(() => rerender({ enabled: false }))
    value.isSecureContext = true
    act(() => rerender({ enabled: true }))
    await waitFor(() => expect(result.current.status?.host.instanceId).toBe("host-fixture"))
    expect(result.current.error).toBeNull()
    expect(clientRuntimeDescriptor().runtimes).toEqual(["browser-iife-v1"])
  })

  it("aborts active work and skips session cleanup requests if browser prerequisites disappear", async () => {
    const current = client(); current.start(); await current.refresh()
    const requestSignal = vi.mocked(authFetch).mock.calls[0]![1]!.signal!
    expect(requestSignal.aborted).toBe(false)
    vi.mocked(authFetch).mockClear()
    value.AbortSignal!.timeout = undefined
    await current.refresh()
    expect(requestSignal.aborted).toBe(true)
    expect(current.getSnapshot()).toMatchObject({ status: null, error: expect.stringContaining("AbortSignal.timeout") })
    expect(authFetch).not.toHaveBeenCalled()
  })
})
