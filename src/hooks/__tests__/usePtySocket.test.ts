import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { usePtySocket } from "@/hooks/usePtySocket"

// Minimal WebSocket stand-in that records the URL it was constructed with and
// never actually fires open/message/close events.
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  url: string
  readyState = 0
  onopen: null | (() => void) = null
  onmessage: null | ((e: MessageEvent) => void) = null
  onclose: null | (() => void) = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED
  }
}

function setLocation(pathname: string, hostname = "localhost") {
  Object.defineProperty(window, "location", {
    value: {
      pathname,
      host: "example.host:19384",
      hostname,
      protocol: "http:",
    },
    writable: true,
    configurable: true,
  })
}

describe("usePtySocket buildWsUrl", () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal("WebSocket", MockWebSocket)
    localStorage.clear()
    setLocation("/")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("connects to /__pty (no prefix) on the local device", () => {
    setLocation("/")
    renderHook(() => usePtySocket())

    expect(MockWebSocket.instances[0]?.url).toBe(
      "ws://example.host:19384/__pty"
    )
  })

  it("inserts the /hub/<id> device prefix before /__pty on a remote device", () => {
    setLocation("/d/dev_x/-Users-foo/sess")
    renderHook(() => usePtySocket())

    expect(MockWebSocket.instances[0]?.url).toBe(
      "ws://example.host:19384/hub/dev_x/__pty"
    )
  })

  it("never places a browser session token in the WebSocket URL", () => {
    localStorage.setItem("cogpit-network-token", "must-not-leak")
    setLocation("/d/dev_x/", "mb.cogpit.dev")
    renderHook(() => usePtySocket())

    expect(MockWebSocket.instances[0]?.url).toBe(
      "ws://example.host:19384/hub/dev_x/__pty"
    )
    expect(MockWebSocket.instances[0]?.url).not.toContain("token=")
  })

  it("tears the socket down on unmount (device switch remounts App)", () => {
    setLocation("/d/dev_x/")
    const { unmount } = renderHook(() => usePtySocket())

    const ws = MockWebSocket.instances[0]
    expect(ws.readyState).not.toBe(MockWebSocket.CLOSED)

    unmount()
    expect(ws.readyState).toBe(MockWebSocket.CLOSED)
  })
})
