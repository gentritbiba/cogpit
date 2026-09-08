import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useBrowserSocket } from "@/hooks/useBrowserSocket"
import { encodeFrame, type FrameHeader } from "../../../shared/browser/frames"
import type { BrowserServerMessage } from "../../../shared/browser/protocol"

// Same stand-in shape as the PTY socket test: it records the constructed URL
// and fires nothing on its own, so every event is driven from the test.
class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  url: string
  binaryType = "blob"
  readyState = 0
  sent: string[] = []
  onopen: null | (() => void) = null
  onmessage: null | ((event: MessageEvent) => void) = null
  onclose: null | (() => void) = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = MockWebSocket.CLOSED
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
  drop() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
}

interface FakeBitmap {
  close: ReturnType<typeof vi.fn>
}

function latest(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

function setLocation(pathname: string, protocol = "http:") {
  Object.defineProperty(window, "location", {
    value: { pathname, host: "example.host:19384", hostname: "localhost", protocol },
    writable: true,
    configurable: true,
  })
}

function makeHeader(overrides: Partial<FrameHeader> = {}): FrameHeader {
  return {
    deviceWidth: 1280,
    deviceHeight: 720,
    pageScaleFactor: 1,
    offsetTop: 0,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    targetId: "T1",
    ts: 1_000,
    ...overrides,
  }
}

function frameBuffer(header: FrameHeader = makeHeader()): ArrayBuffer {
  const bytes = encodeFrame(header, new Uint8Array([1, 2, 3]))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function emitJson(ws: MockWebSocket, message: BrowserServerMessage) {
  ws.emit(JSON.stringify(message))
}

/** `createImageBitmap` that resolves in a microtask, recording every bitmap it hands out. */
function stubBitmaps(): FakeBitmap[] {
  const bitmaps: FakeBitmap[] = []
  vi.stubGlobal("createImageBitmap", vi.fn(() => {
    const bitmap: FakeBitmap = { close: vi.fn() }
    bitmaps.push(bitmap)
    return Promise.resolve(bitmap as unknown as ImageBitmap)
  }))
  return bitmaps
}

/** `createImageBitmap` whose decodes settle only when the test says so. */
function stubDeferredBitmaps() {
  const resolvers: Array<(bitmap: ImageBitmap) => void> = []
  vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((resolve) => {
    resolvers.push(resolve)
  })))
  return {
    async settle(index: number): Promise<FakeBitmap> {
      const bitmap: FakeBitmap = { close: vi.fn() }
      await act(async () => {
        resolvers[index](bitmap as unknown as ImageBitmap)
      })
      return bitmap
    },
  }
}

describe("useBrowserSocket", () => {
  let objectUrls = 0

  beforeEach(() => {
    MockWebSocket.instances = []
    objectUrls = 0
    vi.stubGlobal("WebSocket", MockWebSocket)
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:frame-${++objectUrls}`)
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    setLocation("/")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe("connection", () => {
    it("connects to /__browser with the session name and an arraybuffer channel", () => {
      renderHook(() => useBrowserSocket("default"))

      expect(MockWebSocket.instances[0]?.url).toBe(
        "ws://example.host:19384/__browser?session=default",
      )
      expect(MockWebSocket.instances[0]?.binaryType).toBe("arraybuffer")
    })

    it("keeps the /hub/<id> device prefix and encodes the session name", () => {
      setLocation("/d/dev_x/-Users-foo/sess")
      renderHook(() => useBrowserSocket("a b/c"))

      expect(MockWebSocket.instances[0]?.url).toBe(
        "ws://example.host:19384/hub/dev_x/__browser?session=a%20b%2Fc",
      )
    })

    it("upgrades to wss on an https page", () => {
      setLocation("/", "https:")
      renderHook(() => useBrowserSocket("default"))

      expect(MockWebSocket.instances[0]?.url).toBe(
        "wss://example.host:19384/__browser?session=default",
      )
    })

    it("stays idle and never connects without a session", () => {
      const { result } = renderHook(() => useBrowserSocket(null))

      expect(MockWebSocket.instances).toHaveLength(0)
      expect(result.current.status).toBe("idle")
    })

    it("reports connecting until the socket opens", () => {
      const { result } = renderHook(() => useBrowserSocket("default"))
      expect(result.current.status).toBe("connecting")

      act(() => latest().open())
      expect(result.current.status).toBe("connected")
    })

    it("tears the socket down and returns to idle when the session clears", () => {
      const { result, rerender } = renderHook(
        ({ session }: { session: string | null }) => useBrowserSocket(session),
        { initialProps: { session: "default" as string | null } },
      )
      const ws = latest()
      act(() => ws.open())

      act(() => rerender({ session: null }))

      expect(ws.readyState).toBe(MockWebSocket.CLOSED)
      expect(result.current.status).toBe("idle")
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it("closes the socket on unmount", () => {
      const { unmount } = renderHook(() => useBrowserSocket("default"))
      const ws = latest()

      unmount()

      expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    })
  })

  describe("frames", () => {
    it("decodes a binary frame into a bitmap carrying its header", async () => {
      const bitmaps = stubBitmaps()
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      await act(async () => {
        latest().emit(frameBuffer(makeHeader({ scrollOffsetY: 40, pageScaleFactor: 2 })))
      })

      expect(result.current.frame?.bitmap).toBe(bitmaps[0])
      expect(result.current.frame?.blobUrl).toBeNull()
      expect(result.current.frame?.header.scrollOffsetY).toBe(40)
      expect(result.current.frame?.header.pageScaleFactor).toBe(2)
      expect(result.current.lastFrameAt).toBeGreaterThan(0)
    })

    it("leaves a shown frame to the viewer rather than closing it under a pending paint", async () => {
      const bitmaps = stubBitmaps()
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      await act(async () => latest().emit(frameBuffer(makeHeader({ ts: 1 }))))
      await act(async () => latest().emit(frameBuffer(makeHeader({ ts: 2 }))))

      expect(bitmaps[0].close).not.toHaveBeenCalled()
      expect(bitmaps[1].close).not.toHaveBeenCalled()
      expect(result.current.frame?.header.ts).toBe(2)
    })

    it("closes the last bitmap on unmount", async () => {
      const bitmaps = stubBitmaps()
      const { unmount } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())
      await act(async () => latest().emit(frameBuffer()))

      unmount()

      expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
    })

    it("keeps the newest frame when an older decode resolves late", async () => {
      const deferred = stubDeferredBitmaps()
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      act(() => latest().emit(frameBuffer(makeHeader({ ts: 1 }))))
      act(() => latest().emit(frameBuffer(makeHeader({ ts: 2 }))))
      const second = await deferred.settle(1)
      const first = await deferred.settle(0)

      expect(result.current.frame?.header.ts).toBe(2)
      expect(first.close).toHaveBeenCalledTimes(1)
      expect(second.close).not.toHaveBeenCalled()
    })

    it("closes a bitmap that decodes after teardown", async () => {
      const deferred = stubDeferredBitmaps()
      const { unmount } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())
      act(() => latest().emit(frameBuffer()))

      unmount()
      const bitmap = await deferred.settle(0)

      expect(bitmap.close).toHaveBeenCalledTimes(1)
    })

    it("falls back to an object url where the decoder is missing", async () => {
      vi.stubGlobal("createImageBitmap", undefined)
      const { result, unmount } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      await act(async () => latest().emit(frameBuffer(makeHeader({ ts: 1 }))))
      expect(result.current.frame?.blobUrl).toBe("blob:frame-1")
      expect(result.current.frame?.bitmap).toBeNull()

      await act(async () => latest().emit(frameBuffer(makeHeader({ ts: 2 }))))
      expect(result.current.frame?.blobUrl).toBe("blob:frame-2")
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()

      unmount()
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-2")
    })

    it("ignores a malformed frame", async () => {
      stubBitmaps()
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      await act(async () => latest().emit(new Uint8Array([1, 2]).buffer))

      expect(result.current.frame).toBeNull()
      expect(result.current.lastFrameAt).toBeNull()
    })
  })

  describe("server messages", () => {
    it("applies status, page and tab messages", () => {
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      act(() => emitJson(latest(), { type: "status", state: "live", session: "default" }))
      act(() => emitJson(latest(), {
        type: "page", targetId: "T1", url: "https://x.dev", title: "X", canGoBack: true, canGoForward: false,
      }))
      act(() => emitJson(latest(), {
        type: "tabs", tabs: [{ targetId: "T1", url: "https://x.dev", title: "X" }], followed: "T1",
      }))

      expect(result.current.state?.state).toBe("live")
      expect(result.current.page?.url).toBe("https://x.dev")
      expect(result.current.tabs).toEqual([{ targetId: "T1", url: "https://x.dev", title: "X" }])
      expect(result.current.followed).toBe("T1")
    })

    it("keeps state, page and tab identity when a message repeats", () => {
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())
      const status: BrowserServerMessage = { type: "status", state: "live", session: "default" }
      const page: BrowserServerMessage = {
        type: "page", targetId: "T1", url: "https://x.dev", title: "X", canGoBack: false, canGoForward: false,
      }
      const tabs: BrowserServerMessage = {
        type: "tabs", tabs: [{ targetId: "T1", url: "https://x.dev", title: "X" }], followed: "T1",
      }

      act(() => { emitJson(latest(), status); emitJson(latest(), page); emitJson(latest(), tabs) })
      const first = result.current
      act(() => { emitJson(latest(), status); emitJson(latest(), page); emitJson(latest(), tabs) })

      expect(result.current.state).toBe(first.state)
      expect(result.current.page).toBe(first.page)
      expect(result.current.tabs).toBe(first.tabs)
    })

    it("hands copied text to the latest onClipboard without reconnecting", () => {
      const first = vi.fn()
      const second = vi.fn()
      const { rerender } = renderHook(
        ({ onClipboard }: { onClipboard: (text: string) => void }) => useBrowserSocket("default", onClipboard),
        { initialProps: { onClipboard: first } },
      )
      act(() => latest().open())
      const socket = latest()

      act(() => emitJson(socket, { type: "clipboard", text: "selected words" }))
      rerender({ onClipboard: second })
      act(() => emitJson(socket, { type: "clipboard", text: "more words" }))

      expect(first.mock.calls).toEqual([["selected words"]])
      expect(second.mock.calls).toEqual([["more words"]])
      expect(latest()).toBe(socket)
    })

    it("surfaces an error and clears it on the next status", () => {
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      act(() => emitJson(latest(), { type: "error", message: "no DevTools endpoint" }))
      expect(result.current.error).toBe("no DevTools endpoint")

      act(() => emitJson(latest(), { type: "status", state: "stopped", session: "default" }))
      expect(result.current.error).toBeNull()
    })

    it("ignores malformed text", () => {
      const { result } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      act(() => latest().emit("{nope"))

      expect(result.current.state).toBeNull()
    })
  })

  describe("send", () => {
    it("serialises client messages once the socket is open", () => {
      const { result } = renderHook(() => useBrowserSocket("default"))

      act(() => result.current.send({ type: "reload" }))
      expect(latest().sent).toEqual([])

      act(() => latest().open())
      act(() => result.current.send({ type: "navigate", url: "https://x.dev" }))

      expect(latest().sent).toEqual(['{"type":"navigate","url":"https://x.dev"}'])
    })

    it("no-ops after the socket closes", () => {
      const { result, unmount } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())
      const ws = latest()

      unmount()
      result.current.send({ type: "reload" })

      expect(ws.sent).toEqual([])
    })
  })

  describe("reconnect", () => {
    it("backs off after an unexpected close and resets once open again", () => {
      vi.useFakeTimers()
      renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())

      act(() => latest().drop())
      expect(MockWebSocket.instances).toHaveLength(1)
      act(() => { vi.advanceTimersByTime(500) })
      expect(MockWebSocket.instances).toHaveLength(2)

      act(() => latest().drop())
      act(() => { vi.advanceTimersByTime(500) })
      expect(MockWebSocket.instances).toHaveLength(2)
      act(() => { vi.advanceTimersByTime(500) })
      expect(MockWebSocket.instances).toHaveLength(3)

      act(() => latest().open())
      act(() => latest().drop())
      act(() => { vi.advanceTimersByTime(500) })
      expect(MockWebSocket.instances).toHaveLength(4)
    })

    it("drops a pending reconnect on unmount", () => {
      vi.useFakeTimers()
      const { unmount } = renderHook(() => useBrowserSocket("default"))
      act(() => latest().open())
      act(() => latest().drop())

      unmount()
      act(() => { vi.advanceTimersByTime(10_000) })

      expect(MockWebSocket.instances).toHaveLength(1)
    })
  })

  describe("session change", () => {
    it("opens a new socket and carries nothing over from the old session", async () => {
      const bitmaps = stubBitmaps()
      const { result, rerender } = renderHook(
        ({ session }: { session: string | null }) => useBrowserSocket(session),
        { initialProps: { session: "default" as string | null } },
      )
      const first = latest()
      act(() => first.open())
      act(() => emitJson(first, {
        type: "tabs", tabs: [{ targetId: "T1", url: "https://x.dev", title: "X" }], followed: "T1",
      }))
      act(() => emitJson(first, { type: "error", message: "boom" }))
      await act(async () => first.emit(frameBuffer()))

      await act(async () => rerender({ session: "github" }))

      expect(first.readyState).toBe(MockWebSocket.CLOSED)
      expect(latest().url).toBe("ws://example.host:19384/__browser?session=github")
      expect(bitmaps[0].close).toHaveBeenCalledTimes(1)
      expect(result.current.frame).toBeNull()
      expect(result.current.lastFrameAt).toBeNull()
      expect(result.current.tabs).toEqual([])
      expect(result.current.followed).toBeNull()
      expect(result.current.error).toBeNull()
    })

    it("never shows a frame decoded for the previous session", async () => {
      const deferred = stubDeferredBitmaps()
      const { result, rerender } = renderHook(
        ({ session }: { session: string | null }) => useBrowserSocket(session),
        { initialProps: { session: "default" as string | null } },
      )
      act(() => latest().open())
      act(() => latest().emit(frameBuffer()))

      await act(async () => rerender({ session: "github" }))
      const stale = await deferred.settle(0)

      expect(stale.close).toHaveBeenCalledTimes(1)
      expect(result.current.frame).toBeNull()
    })
  })
})
