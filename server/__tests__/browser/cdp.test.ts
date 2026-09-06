// @vitest-environment node
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { BrowserViewer, CdpConnection, type PageInfo, type ViewerEvents } from "../../browser/cdp"
import type { FrameHeader } from "../../../shared/browser/frames"
import type { BrowserTab } from "../../../shared/browser/protocol"

interface CdpMessage {
  id: number
  method: string
  params: Record<string, any>
  sessionId?: string
}

interface TargetInfo {
  targetId: string
  type: string
  url: string
  title: string
  attached: boolean
}

type Handler = (message: CdpMessage, fake: FakeCdp) => unknown

class CdpError extends Error {}

interface FakeCdp {
  url: string
  messages: CdpMessage[]
  handlers: Record<string, Handler>
  targets: TargetInfo[]
  history: { currentIndex: number; entries: { id: number; url: string; title: string }[] }
  /** The connected viewer socket, once it arrived. */
  socket: WebSocket | null
  /** Metadata of pushed screencast frames; `Page.startScreencast` refreshes the device size. */
  frameMetadata: Record<string, number>
  push(method: string, params: unknown, sessionId?: string): void
  pushFrame(frameId: number, sessionId?: string): void
  pushRaw(text: string): void
  sent(method: string): CdpMessage[]
  close(): Promise<void>
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])
/** Distinct per frame, so an ack that is constant or missing fails the assertions. */
const FRAME_IDS = [7, 8]
const SCROLL_METADATA = { pageScaleFactor: 2, offsetTop: 24, scrollOffsetX: 8, scrollOffsetY: 120 }
/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const META = 4
const SHIFT = 8

function page(targetId: string, url = `https://${targetId}.test/`, title = `Title ${targetId}`): TargetInfo {
  return { targetId, type: "page", url, title, attached: false }
}

function sessionFor(targetId: string): string {
  return `session-${targetId}`
}

const servers: FakeCdp[] = []
const viewers: BrowserViewer[] = []

async function startFakeCdp(targets: TargetInfo[] = [page("t1"), page("t2")]): Promise<FakeCdp> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await once(wss, "listening")

  const fake: FakeCdp = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/devtools/browser/fake`,
    messages: [],
    targets,
    history: { currentIndex: 0, entries: [{ id: 1, url: "https://t2.test/", title: "Title t2" }] },
    socket: null,
    frameMetadata: { deviceWidth: 0, deviceHeight: 0, ...SCROLL_METADATA },
    handlers: {
      "Target.setDiscoverTargets": (_message, self) => {
        for (const targetInfo of self.targets) self.push("Target.targetCreated", { targetInfo })
        return {}
      },
      "Target.getTargets": (_message, self) => ({ targetInfos: self.targets }),
      "Target.attachToTarget": (message) => ({ sessionId: sessionFor(message.params.targetId) }),
      "Page.enable": () => ({}),
      "Page.startScreencast": (message, self) => {
        self.frameMetadata = { deviceWidth: message.params.maxWidth, deviceHeight: message.params.maxHeight, ...SCROLL_METADATA }
        self.pushFrame(FRAME_IDS[0], message.sessionId)
        return {}
      },
      "Page.screencastFrameAck": (message, self) => {
        // Chromium holds the next frame until the previous one is acked.
        if (message.params.sessionId === FRAME_IDS[0]) self.pushFrame(FRAME_IDS[1], message.sessionId)
        return {}
      },
      "Page.stopScreencast": () => ({}),
      "Emulation.setDeviceMetricsOverride": () => ({}),
      "Emulation.clearDeviceMetricsOverride": () => ({}),
      "Page.getNavigationHistory": (_message, self) => self.history,
      "Page.navigate": () => ({ frameId: "main", loaderId: "loader" }),
      "Page.navigateToHistoryEntry": () => ({}),
      "Page.reload": () => ({}),
      "Input.dispatchMouseEvent": () => ({}),
      "Input.dispatchKeyEvent": () => ({}),
    },
    push(method, params, sessionId) {
      fake.socket?.send(JSON.stringify(sessionId === undefined ? { method, params } : { method, params, sessionId }))
    },
    pushFrame(frameId, sessionId) {
      const data = Buffer.from(JPEG).toString("base64")
      fake.push("Page.screencastFrame", { data, metadata: fake.frameMetadata, sessionId: frameId }, sessionId)
    },
    pushRaw(text) {
      fake.socket?.send(text)
    },
    sent(method) {
      return fake.messages.filter((message) => message.method === method)
    },
    close() {
      return new Promise((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resolve())
      })
    },
  }

  wss.on("connection", (socket) => {
    fake.socket = socket
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as CdpMessage
      fake.messages.push(message)
      const handler = fake.handlers[message.method]
      const result = handler
        ? handler(message, fake)
        : new CdpError(`'${message.method}' wasn't found`)
      if (result === undefined) return
      const reply = result instanceof Error
        ? { id: message.id, error: { code: -32601, message: result.message } }
        : { id: message.id, result }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply))
    })
  })

  servers.push(fake)
  return fake
}

interface Recorded extends ViewerEvents {
  frames: { header: FrameHeader; jpeg: Uint8Array }[]
  tabLists: { tabs: BrowserTab[]; followed: string | null }[]
  pages: PageInfo[]
  errors: string[]
  closeReasons: string[]
}

function record(): Recorded {
  const recorded: Recorded = {
    frames: [],
    tabLists: [],
    pages: [],
    errors: [],
    closeReasons: [],
    frame: (header, jpeg) => {
      recorded.frames.push({ header, jpeg })
    },
    tabs: (tabs, followed) => recorded.tabLists.push({ tabs, followed }),
    page: (info) => recorded.pages.push(info),
    error: (message) => recorded.errors.push(message),
    closed: (reason) => recorded.closeReasons.push(reason),
  }
  return recorded
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function openViewer(
  targets?: TargetInfo[],
  events: Recorded = record(),
): Promise<{ fake: FakeCdp; events: Recorded; viewer: BrowserViewer }> {
  const fake = await startFakeCdp(targets)
  const viewer = await BrowserViewer.open(fake.url, events)
  viewers.push(viewer)
  return { fake, events, viewer }
}

function last<T>(items: T[]): T {
  expect(items.length).toBeGreaterThan(0)
  return items[items.length - 1]
}

function tabIds(entry: { tabs: BrowserTab[] }): string[] {
  return entry.tabs.map((tab) => tab.targetId)
}

afterEach(async () => {
  await Promise.all(viewers.splice(0).map((viewer) => viewer.close()))
  await Promise.all(servers.splice(0).map((fake) => fake.close()))
})

describe("CdpConnection", () => {
  it("rejects connect when nothing listens", async () => {
    const fake = await startFakeCdp()
    const url = fake.url
    await fake.close()
    servers.splice(servers.indexOf(fake), 1)
    await expect(CdpConnection.connect(url)).rejects.toBeInstanceOf(Error)
  })

  it("resolves results, rejects CDP errors and ignores malformed input", async () => {
    const fake = await startFakeCdp()
    const cdp = await CdpConnection.connect(fake.url)
    fake.handlers["Custom.echo"] = (message) => ({ echoed: message.params, session: message.sessionId })

    await expect(cdp.send("Custom.echo", { a: 1 }, "s1")).resolves.toEqual({ echoed: { a: 1 }, session: "s1" })
    await expect(cdp.send("Nope.method")).rejects.toThrow("'Nope.method' wasn't found")

    fake.pushRaw("{not json")
    fake.pushRaw("[1,2]")
    await expect(cdp.send("Custom.echo", {})).resolves.toEqual({ echoed: {} })

    const ids = fake.messages.map((message) => message.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
    cdp.close()
  })

  it("dispatches events with their session and survives a throwing handler", async () => {
    const fake = await startFakeCdp()
    const cdp = await CdpConnection.connect(fake.url)
    const seen: unknown[] = []
    const bad = () => {
      throw new Error("handler failure")
    }
    cdp.on("Custom.event", bad)
    cdp.on("Custom.event", (params, sessionId) => seen.push({ params, sessionId }))
    fake.push("Custom.event", { x: 1 }, "s9")
    fake.push("Custom.event", { x: 2 })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen).toEqual([{ params: { x: 1 }, sessionId: "s9" }, { params: { x: 2 }, sessionId: undefined }])

    cdp.off("Custom.event", bad)
    fake.push("Custom.event", { x: 3 })
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    cdp.close()
  })

  it("rejects pending sends and reports close once when the socket drops", async () => {
    const fake = await startFakeCdp()
    const cdp = await CdpConnection.connect(fake.url)
    const reasons: string[] = []
    cdp.onClose((reason) => reasons.push(reason))
    fake.handlers["Slow.call"] = (_message, self) => {
      self.socket?.terminate()
      return undefined
    }
    await expect(cdp.send("Slow.call")).rejects.toThrow("CDP connection closed")
    await vi.waitFor(() => expect(reasons).toHaveLength(1))
    await expect(cdp.send("Anything")).rejects.toThrow("CDP connection closed")
    cdp.close()
    expect(reasons).toHaveLength(1)
  })
})

describe("BrowserViewer", () => {
  it("attaches to page targets only and follows the newest", async () => {
    const { fake, events } = await openViewer([
      { targetId: "browser", type: "browser", url: "", title: "", attached: true },
      page("t1"),
      page("devtools", "devtools://devtools/bundled/inspector.html"),
      page("ext", "chrome-extension://abc/popup.html"),
      page("t2"),
    ])

    expect(fake.sent("Target.setDiscoverTargets")[0].params).toEqual({ discover: true })
    expect(fake.sent("Target.getTargets")).toHaveLength(1)
    expect(fake.sent("Target.attachToTarget").map((m) => m.params)).toEqual([
      { targetId: "t1", flatten: true },
      { targetId: "t2", flatten: true },
    ])
    expect(fake.sent("Page.enable").map((m) => m.sessionId)).toEqual([sessionFor("t1"), sessionFor("t2")])

    expect(events.tabLists).toHaveLength(1)
    expect(events.tabLists[0]).toEqual({
      tabs: [
        { targetId: "t1", url: "https://t1.test/", title: "Title t1" },
        { targetId: "t2", url: "https://t2.test/", title: "Title t2" },
      ],
      followed: "t2",
    })
    expect(events.pages).toEqual([
      { targetId: "t2", url: "https://t2.test/", title: "Title t2", canGoBack: false, canGoForward: false },
    ])
    expect(fake.sent("Page.startScreencast")).toHaveLength(0)
  })

  it("reports an empty page when the browser has no tabs", async () => {
    const { events, viewer } = await openViewer([])
    expect(events.tabLists).toEqual([{ tabs: [], followed: null }])
    expect(events.pages).toEqual([{ targetId: "", url: "", title: "", canGoBack: false, canGoForward: false }])
    await expect(viewer.mouse({ type: "mouse", event: "move", x: 1, y: 1, button: "none", clickCount: 0, modifiers: 0 }))
      .rejects.toThrow("No open tab")
  })

  it("streams frames for the followed tab and acks each one", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)

    const start = last(fake.sent("Page.startScreencast"))
    expect(start.sessionId).toBe(sessionFor("t2"))
    expect(start.params).toEqual({ format: "jpeg", quality: 80, maxWidth: 800, maxHeight: 600, everyNthFrame: 1 })

    await vi.waitFor(() => expect(events.frames).toHaveLength(2))
    for (const frame of events.frames) {
      expect(frame.header).toMatchObject({ deviceWidth: 800, deviceHeight: 600, targetId: "t2", ...SCROLL_METADATA })
      expect(typeof frame.header.ts).toBe("number")
      expect(Array.from(frame.jpeg)).toEqual(Array.from(JPEG))
    }
    await vi.waitFor(() => expect(fake.sent("Page.screencastFrameAck")).toHaveLength(2))
    expect(fake.sent("Page.screencastFrameAck").map((ack) => [ack.sessionId, ack.params.sessionId])).toEqual([
      [sessionFor("t2"), FRAME_IDS[0]],
      [sessionFor("t2"), FRAME_IDS[1]],
    ])

    const data = Buffer.from(JPEG).toString("base64")
    fake.push("Page.screencastFrame", { data, metadata: { deviceWidth: 1, deviceHeight: 1 }, sessionId: 3 }, sessionFor("t1"))
    await vi.waitFor(() => expect(fake.sent("Page.screencastFrameAck")).toHaveLength(3))
    expect(last(fake.sent("Page.screencastFrameAck"))).toMatchObject({ sessionId: sessionFor("t1"), params: { sessionId: 3 } })
    expect(events.frames).toHaveLength(2)

    fake.push("Page.screencastFrame", { data, metadata: { deviceWidth: 5, deviceHeight: 6 }, sessionId: 9 }, sessionFor("t2"))
    await vi.waitFor(() => expect(events.frames).toHaveLength(3))
    expect(last(events.frames).header).toMatchObject({
      deviceWidth: 5, deviceHeight: 6, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0,
    })
    expect(events.errors).toEqual([])
  })

  it("waits for the viewer to flush a frame before acking it, and acks even when it throws", async () => {
    const events = record()
    const flush = deferred()
    events.frame = (header, jpeg) => {
      events.frames.push({ header, jpeg })
      return flush.promise
    }
    const { fake, viewer } = await openViewer(undefined, events)
    await viewer.setViewport(800, 600, 1)

    await vi.waitFor(() => expect(events.frames).toHaveLength(1))
    // A full round trip on the same socket: an ack sent ahead of the flush would already be recorded.
    await viewer.reload()
    expect(fake.sent("Page.screencastFrameAck")).toHaveLength(0)

    flush.resolve()
    await vi.waitFor(() => expect(fake.sent("Page.screencastFrameAck")).toHaveLength(2))
    expect(events.frames).toHaveLength(2)

    events.frame = () => {
      throw new Error("viewer gone")
    }
    fake.pushFrame(11, sessionFor("t2"))
    await vi.waitFor(() => expect(events.errors).toEqual(["viewer gone"]))
    expect(last(fake.sent("Page.screencastFrameAck")).params).toEqual({ sessionId: 11 })
  })

  it("reports a failed screencast start and retries on the next follow", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)
    const startScreencast = fake.handlers["Page.startScreencast"]
    fake.handlers["Page.startScreencast"] = () => {
      fake.handlers["Page.startScreencast"] = startScreencast
      return new CdpError("Screencast unavailable")
    }

    fake.push("Target.targetCreated", { targetInfo: page("t3") })
    await vi.waitFor(() => expect(events.errors).toEqual(["Screencast unavailable"]))
    const stopsAfterFailure = fake.sent("Page.stopScreencast").length

    await viewer.follow("t1")
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t1"))
    // Nothing was streaming, so the retry has nothing to stop first.
    expect(fake.sent("Page.stopScreencast")).toHaveLength(stopsAfterFailure)
  })

  it("scales the screencast by dpr, caps it, and only restarts on change", async () => {
    const { fake, viewer } = await openViewer()

    await viewer.setViewport(1000, 1000, 2)
    expect(last(fake.sent("Page.startScreencast")).params).toMatchObject({ maxWidth: 1920, maxHeight: 1920 })

    await viewer.setViewport(500.4, 300.2, 3)
    expect(last(fake.sent("Page.startScreencast")).params).toMatchObject({ maxWidth: 1001, maxHeight: 600 })
    expect(fake.sent("Page.stopScreencast")).toHaveLength(1)

    await viewer.setViewport(500.4, 300.2, 3)
    expect(fake.sent("Page.startScreencast")).toHaveLength(2)
    expect(fake.sent("Page.stopScreencast")).toHaveLength(1)
    expect(fake.sent("Emulation.setDeviceMetricsOverride")).toHaveLength(2)

    await Promise.all([viewer.setViewport(640, 480, 1), viewer.setViewport(320, 240, 1)])
    const screencastCalls = fake.messages
      .filter((m) => m.method === "Page.startScreencast" || m.method === "Page.stopScreencast")
      .map((m) => m.method)
    expect(screencastCalls).toEqual([
      "Page.startScreencast",
      "Page.stopScreencast", "Page.startScreencast",
      "Page.stopScreencast", "Page.startScreencast",
    ])
    expect(last(fake.sent("Page.startScreencast")).params).toMatchObject({ maxWidth: 320, maxHeight: 240 })
  })

  it("emulates the panel's aspect ratio, widening a narrow panel to the floor", async () => {
    const { fake, viewer } = await openViewer()

    await viewer.setViewport(715, 907, 2)
    const override = last(fake.sent("Emulation.setDeviceMetricsOverride"))
    expect(override.sessionId).toBe(sessionFor("t2"))
    expect(override.params).toEqual({
      width: 1024,
      height: 1299,
      deviceScaleFactor: 2,
      mobile: false,
      screenWidth: 1024,
      screenHeight: 1299,
    })
    // The screencast has to read the page's new box, so the override goes first.
    const methods = fake.messages.map((message) => message.method)
    expect(methods.indexOf("Emulation.setDeviceMetricsOverride"))
      .toBeLessThan(methods.indexOf("Page.startScreencast"))
    expect(last(fake.sent("Page.startScreencast")).params).toMatchObject({ maxWidth: 1430, maxHeight: 1814 })
  })

  it("emulates a panel wider than the floor at its own size", async () => {
    const { fake, viewer } = await openViewer()

    await viewer.setViewport(1600, 900, 1)
    expect(last(fake.sent("Emulation.setDeviceMetricsOverride")).params).toMatchObject({
      width: 1600, height: 900, deviceScaleFactor: 1,
    })
    expect(last(fake.sent("Page.startScreencast")).params).toMatchObject({ maxWidth: 1600, maxHeight: 900 })
  })

  it("moves the override to the newly followed tab and clears the old one", async () => {
    const { fake, viewer } = await openViewer()
    await viewer.setViewport(715, 907, 2)

    await viewer.follow("t1")
    expect(last(fake.sent("Emulation.clearDeviceMetricsOverride")).sessionId).toBe(sessionFor("t2"))
    const reapplied = last(fake.sent("Emulation.setDeviceMetricsOverride"))
    expect(reapplied.sessionId).toBe(sessionFor("t1"))
    expect(reapplied.params).toMatchObject({ width: 1024, height: 1299 })
  })

  it("leaves the page its own size again when the viewer closes", async () => {
    const { fake, viewer } = await openViewer()
    await viewer.setViewport(715, 907, 2)

    await viewer.close()
    expect(last(fake.sent("Emulation.clearDeviceMetricsOverride")).sessionId).toBe(sessionFor("t2"))
  })

  it("still streams, letterboxed, when the page refuses the override", async () => {
    const { fake, events, viewer } = await openViewer()
    fake.handlers["Emulation.setDeviceMetricsOverride"] = () => new CdpError("Emulation unavailable")

    await viewer.setViewport(715, 907, 2)
    expect(events.errors).toEqual(["Emulation unavailable"])
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t2"))
  })

  it("has no aspect ratio to emulate for a panel with no width", async () => {
    const { fake, viewer } = await openViewer()

    await viewer.setViewport(0, 907, 2)
    expect(fake.sent("Emulation.setDeviceMetricsOverride")).toHaveLength(0)
  })

  it("follow moves the screencast and input to the chosen tab", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)

    await viewer.follow("t1")
    expect(last(fake.sent("Page.stopScreencast")).sessionId).toBe(sessionFor("t2"))
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t1"))
    expect(last(events.tabLists).followed).toBe("t1")
    expect(last(events.pages).targetId).toBe("t1")

    await viewer.mouse({ type: "mouse", event: "down", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 })
    expect(last(fake.sent("Input.dispatchMouseEvent")).sessionId).toBe(sessionFor("t1"))

    const before = events.tabLists.length
    await viewer.follow("t1")
    expect(events.tabLists).toHaveLength(before)

    await expect(viewer.follow("nope")).rejects.toThrow("Unknown tab")
  })

  it("dispatches mouse and wheel events", async () => {
    const { fake, viewer } = await openViewer()
    await viewer.mouse({ type: "mouse", event: "move", x: 1.5, y: 2.5, button: "none", clickCount: 0, modifiers: 0 })
    await viewer.mouse({ type: "mouse", event: "down", x: 10, y: 20, button: "left", clickCount: 2, modifiers: 2 })
    await viewer.mouse({ type: "mouse", event: "up", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 })
    await viewer.wheel({ type: "wheel", x: 5, y: 6, deltaX: -3, deltaY: 120, modifiers: 4 })

    expect(fake.sent("Input.dispatchMouseEvent").map((m) => m.params)).toEqual([
      { type: "mouseMoved", x: 1.5, y: 2.5, button: "none", clickCount: 0, modifiers: 0, buttons: 0 },
      { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 2, modifiers: 2, buttons: 1 },
      { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0, buttons: 0 },
      { type: "mouseWheel", x: 5, y: 6, deltaX: -3, deltaY: 120, modifiers: 4, buttons: 0 },
    ])
    expect(fake.sent("Input.dispatchMouseEvent").every((m) => m.sessionId === sessionFor("t2"))).toBe(true)
  })

  it("carries the held buttons through a drag so Blink sees a selection, not a hover", async () => {
    const { fake, viewer } = await openViewer()
    await viewer.mouse({ type: "mouse", event: "down", x: 10, y: 10, button: "left", clickCount: 1, modifiers: 0 })
    await viewer.mouse({ type: "mouse", event: "move", x: 40, y: 10, button: "none", clickCount: 0, modifiers: 0 })
    await viewer.wheel({ type: "wheel", x: 40, y: 10, deltaX: 0, deltaY: 30, modifiers: 0 })
    await viewer.mouse({ type: "mouse", event: "down", x: 40, y: 10, button: "right", clickCount: 1, modifiers: 0 })
    await viewer.mouse({ type: "mouse", event: "up", x: 40, y: 10, button: "left", clickCount: 1, modifiers: 0 })
    await viewer.mouse({ type: "mouse", event: "move", x: 60, y: 10, button: "none", clickCount: 0, modifiers: 0 })

    expect(fake.sent("Input.dispatchMouseEvent").map((m) => [m.params.type, m.params.buttons])).toEqual([
      ["mousePressed", 1],
      ["mouseMoved", 1],
      ["mouseWheel", 1],
      ["mousePressed", 3],
      ["mouseReleased", 2],
      ["mouseMoved", 2],
    ])
  })

  it("maps key events and derives virtual key codes from the physical code", async () => {
    const { fake, viewer } = await openViewer()
    await viewer.key({ type: "key", event: "down", key: "Enter", code: "Enter", modifiers: 0 })
    await viewer.key({ type: "key", event: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 })
    await viewer.key({ type: "key", event: "up", key: "a", code: "KeyA", modifiers: 0 })
    await viewer.key({ type: "key", event: "down", key: "Shift", code: "ShiftLeft", modifiers: 8 })
    await viewer.key({ type: "key", event: "down", key: "ArrowDown", code: "ArrowDown", modifiers: 0 })
    await viewer.key({ type: "key", event: "up", key: "Backspace", code: "Backspace", modifiers: 0 })
    await viewer.key({ type: "key", event: "down", key: "Home", code: "Home", modifiers: 0 })
    await viewer.key({ type: "key", event: "down", key: " ", code: "Space", text: " ", modifiers: 0 })
    await viewer.key({ type: "key", event: "down", key: "7", code: "Digit7", text: "7", modifiers: 0 })
    await viewer.key({ type: "key", event: "down", key: "z", code: "KeyZ", text: "z", modifiers: 0 })

    expect(fake.sent("Input.dispatchKeyEvent").map((m) => m.params)).toEqual([
      { type: "rawKeyDown", key: "Enter", code: "Enter", modifiers: 0, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      { type: "keyDown", key: "a", code: "KeyA", modifiers: 0, text: "a", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
      { type: "keyUp", key: "a", code: "KeyA", modifiers: 0, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 },
      { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 },
      { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", modifiers: 0, windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
      { type: "keyUp", key: "Backspace", code: "Backspace", modifiers: 0, windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
      { type: "rawKeyDown", key: "Home", code: "Home", modifiers: 0, windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
      { type: "keyDown", key: " ", code: "Space", modifiers: 0, text: " ", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
      { type: "keyDown", key: "7", code: "Digit7", modifiers: 0, text: "7", windowsVirtualKeyCode: 55, nativeVirtualKeyCode: 55 },
      { type: "keyDown", key: "z", code: "KeyZ", modifiers: 0, text: "z", windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 },
    ])
    expect(fake.sent("Input.dispatchKeyEvent").every((m) => m.params.commands === undefined)).toBe(true)
  })

  it("sends macOS editor commands for Meta shortcuts on key down only", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    try {
      const { fake, viewer } = await openViewer()
      await viewer.key({ type: "key", event: "down", key: "a", code: "KeyA", modifiers: META })
      await viewer.key({ type: "key", event: "up", key: "a", code: "KeyA", modifiers: META })
      await viewer.key({ type: "key", event: "down", key: "v", code: "KeyV", modifiers: META })
      await viewer.key({ type: "key", event: "down", key: "Z", code: "KeyZ", modifiers: META | SHIFT })
      await viewer.key({ type: "key", event: "down", key: "z", code: "KeyZ", modifiers: META })
      await viewer.key({ type: "key", event: "down", key: "y", code: "KeyY", modifiers: META })
      await viewer.key({ type: "key", event: "down", key: "b", code: "KeyB", modifiers: META })
      await viewer.key({ type: "key", event: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 })

      expect(fake.sent("Input.dispatchKeyEvent").map((m) => [m.params.type, m.params.windowsVirtualKeyCode, m.params.commands])).toEqual([
        ["rawKeyDown", 65, ["selectAll"]],
        ["keyUp", 65, undefined],
        ["rawKeyDown", 86, ["paste"]],
        ["rawKeyDown", 90, ["redo"]],
        ["rawKeyDown", 90, ["undo"]],
        ["rawKeyDown", 89, ["redo"]],
        ["rawKeyDown", 66, undefined],
        ["keyDown", 65, undefined],
      ])
      expect(last(fake.sent("Input.dispatchKeyEvent")).params.text).toBe("a")
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  it("leaves editor commands out off macOS", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      const { fake, viewer } = await openViewer()
      await viewer.key({ type: "key", event: "down", key: "a", code: "KeyA", modifiers: META })
      expect(last(fake.sent("Input.dispatchKeyEvent")).params.commands).toBeUndefined()
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  it("navigates with the resolved url and rejects unsafe schemes", async () => {
    const { fake, viewer } = await openViewer()
    await viewer.navigate("example.com")
    await viewer.navigate("localhost:3000")
    expect(fake.sent("Page.navigate").map((m) => [m.params.url, m.sessionId])).toEqual([
      ["https://example.com", sessionFor("t2")],
      ["http://localhost:3000", sessionFor("t2")],
    ])

    await expect(viewer.navigate("javascript:alert(1)")).rejects.toThrow()
    expect(fake.sent("Page.navigate")).toHaveLength(2)
  })

  it("surfaces CDP errors from input methods", async () => {
    const { fake, viewer } = await openViewer()
    fake.handlers["Page.navigate"] = () => new CdpError("Cannot navigate to invalid URL")
    await expect(viewer.navigate("https://example.com")).rejects.toThrow("Cannot navigate to invalid URL")
  })

  it("steps through history by entry id and reloads", async () => {
    const { fake, events, viewer } = await openViewer()
    fake.history = {
      currentIndex: 1,
      entries: [
        { id: 11, url: "https://a.test/", title: "A" },
        { id: 22, url: "https://b.test/", title: "B" },
        { id: 33, url: "https://c.test/", title: "C" },
      ],
    }
    await viewer.back()
    await viewer.forward()
    expect(fake.sent("Page.navigateToHistoryEntry").map((m) => m.params)).toEqual([{ entryId: 11 }, { entryId: 33 }])

    fake.history = { currentIndex: 0, entries: [{ id: 11, url: "https://a.test/", title: "A" }] }
    await viewer.back()
    await viewer.forward()
    expect(fake.sent("Page.navigateToHistoryEntry")).toHaveLength(2)

    await viewer.reload()
    expect(last(fake.sent("Page.reload")).sessionId).toBe(sessionFor("t2"))

    fake.history = {
      currentIndex: 1,
      entries: [
        { id: 11, url: "https://a.test/", title: "A" },
        { id: 22, url: "https://b.test/", title: "B" },
        { id: 33, url: "https://c.test/", title: "C" },
      ],
    }
    await viewer.follow("t1")
    expect(last(events.pages)).toMatchObject({ targetId: "t1", canGoBack: true, canGoForward: true })
  })

  it("emits page on main-frame navigation and on title changes of the followed tab", async () => {
    const { fake, events } = await openViewer()
    const pagesBefore = events.pages.length

    fake.push("Page.frameNavigated", { frame: { id: "child", parentId: "main", url: "https://iframe.test/" } }, sessionFor("t2"))
    fake.push("Page.frameNavigated", { frame: { id: "main", url: "https://t2.test/next" } }, sessionFor("t2"))
    await vi.waitFor(() => expect(events.pages).toHaveLength(pagesBefore + 1))
    expect(last(events.pages)).toMatchObject({ targetId: "t2", url: "https://t2.test/next" })

    fake.push("Page.frameNavigated", { frame: { id: "main", url: "https://t1.test/elsewhere" } }, sessionFor("t1"))
    fake.push("Target.targetInfoChanged", { targetInfo: page("t1", "https://t1.test/elsewhere", "Elsewhere") })
    fake.push("Target.targetInfoChanged", { targetInfo: page("t2", "https://t2.test/next", "Next") })
    await vi.waitFor(() => expect(last(events.pages).title).toBe("Next"))
    expect(events.pages.filter((info) => info.targetId === "t1")).toHaveLength(0)
    expect(last(events.tabLists).tabs).toEqual([
      { targetId: "t1", url: "https://t1.test/elsewhere", title: "Elsewhere" },
      { targetId: "t2", url: "https://t2.test/next", title: "Next" },
    ])
  })

  it("follows newly created tabs unless the user pinned one", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)

    fake.push("Target.targetCreated", { targetInfo: page("t3") })
    await vi.waitFor(() => expect(last(events.tabLists).followed).toBe("t3"))
    expect(tabIds(last(events.tabLists))).toEqual(["t1", "t2", "t3"])
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t3"))

    await viewer.follow("t1")
    fake.push("Target.targetCreated", { targetInfo: page("t4") })
    await vi.waitFor(() => expect(tabIds(last(events.tabLists))).toEqual(["t1", "t2", "t3", "t4"]))
    expect(last(events.tabLists).followed).toBe("t1")
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t1"))

    fake.push("Target.targetCreated", { targetInfo: page("t1") })
    fake.push("Target.targetCreated", { targetInfo: { targetId: "worker", type: "service_worker", url: "https://w.test/sw.js", title: "", attached: false } })
    await viewer.mouse({ type: "mouse", event: "move", x: 0, y: 0, button: "none", clickCount: 0, modifiers: 0 })
    expect(fake.sent("Target.attachToTarget").map((m) => m.params.targetId)).toEqual(["t1", "t2", "t3", "t4"])
  })

  it("re-follows the newest remaining tab when the followed one is destroyed", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)
    await viewer.follow("t1")
    fake.push("Target.targetCreated", { targetInfo: page("t3") })
    await vi.waitFor(() => expect(tabIds(last(events.tabLists))).toEqual(["t1", "t2", "t3"]))
    const stopsBefore = fake.sent("Page.stopScreencast").length

    fake.push("Target.targetDestroyed", { targetId: "t1" })
    await vi.waitFor(() => expect(last(events.tabLists).followed).toBe("t3"))
    expect(tabIds(last(events.tabLists))).toEqual(["t2", "t3"])
    expect(last(events.pages).targetId).toBe("t3")
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t3"))
    expect(fake.sent("Page.stopScreencast")).toHaveLength(stopsBefore)

    fake.push("Target.targetDestroyed", { targetId: "t2" })
    await vi.waitFor(() => expect(tabIds(last(events.tabLists))).toEqual(["t3"]))
    expect(last(events.tabLists).followed).toBe("t3")
    expect(last(events.pages).targetId).toBe("t3")

    fake.push("Target.targetDestroyed", { targetId: "t3" })
    await vi.waitFor(() => expect(last(events.tabLists)).toEqual({ tabs: [], followed: null }))
    expect(last(events.pages)).toEqual({ targetId: "", url: "", title: "", canGoBack: false, canGoForward: false })

    fake.push("Target.targetDestroyed", { targetId: "never-attached" })
    fake.push("Target.targetCreated", { targetInfo: page("t5") })
    await vi.waitFor(() => expect(last(events.tabLists).followed).toBe("t5"))
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t5"))
  })

  it("close stops the screencast and closes the socket without reporting a crash", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)

    await viewer.close()
    await viewer.close()
    expect(last(fake.sent("Page.stopScreencast")).sessionId).toBe(sessionFor("t2"))
    await vi.waitFor(() => expect(fake.socket?.readyState).toBe(WebSocket.CLOSED))

    await viewer.setViewport(100, 100, 1)
    expect(fake.sent("Page.startScreencast")).toHaveLength(1)
    await expect(viewer.reload()).rejects.toThrow("CDP connection closed")
    expect(events.closeReasons).toEqual([])
    expect(events.errors).toEqual([])
  })

  it("reports closed when the browser drops the connection", async () => {
    const { fake, events, viewer } = await openViewer()
    fake.handlers["Page.reload"] = (_message, self) => {
      self.socket?.terminate()
      return undefined
    }
    await expect(viewer.reload()).rejects.toThrow("CDP connection closed")
    await vi.waitFor(() => expect(events.closeReasons).toHaveLength(1))
    await viewer.close()
    expect(events.closeReasons).toHaveLength(1)
  })

  it("rejects a failed open without reporting closed", async () => {
    const fake = await startFakeCdp()
    fake.handlers["Target.setDiscoverTargets"] = () => new CdpError("Not allowed")
    const events = record()

    await expect(BrowserViewer.open(fake.url, events)).rejects.toThrow("Not allowed")
    expect(events.closeReasons).toEqual([])
    expect(events.errors).toEqual([])
    await vi.waitFor(() => expect(fake.socket?.readyState).toBe(WebSocket.CLOSED))
  })

  it("drops a tab that navigates into a hidden scheme and takes it back when it returns", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)

    fake.push("Target.targetInfoChanged", { targetInfo: page("t2", "devtools://devtools/bundled/inspector.html", "DevTools") })
    await vi.waitFor(() => expect(tabIds(last(events.tabLists))).toEqual(["t1"]))
    expect(last(events.tabLists).followed).toBe("t1")
    expect(last(fake.sent("Page.stopScreencast")).sessionId).toBe(sessionFor("t2"))
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t1"))

    fake.push("Target.targetInfoChanged", { targetInfo: page("t2") })
    await vi.waitFor(() => expect(tabIds(last(events.tabLists))).toEqual(["t1", "t2"]))
    expect(last(events.tabLists).followed).toBe("t2")
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t2"))
    expect(events.errors).toEqual([])
  })

  it("drops a target that detaches or crashes and re-follows", async () => {
    const { fake, events, viewer } = await openViewer()
    await viewer.setViewport(800, 600, 1)

    fake.push("Target.detachedFromTarget", { sessionId: sessionFor("t2") })
    await vi.waitFor(() => expect(last(events.tabLists).followed).toBe("t1"))
    expect(tabIds(last(events.tabLists))).toEqual(["t1"])
    expect(last(fake.sent("Page.startScreencast")).sessionId).toBe(sessionFor("t1"))
    // The session is gone, so nothing is sent to it.
    expect(fake.sent("Page.stopScreencast")).toHaveLength(0)

    fake.push("Inspector.targetCrashed", {}, sessionFor("t1"))
    await vi.waitFor(() => expect(last(events.tabLists)).toEqual({ tabs: [], followed: null }))
    expect(last(events.pages)).toEqual({ targetId: "", url: "", title: "", canGoBack: false, canGoForward: false })

    await expect(viewer.reload()).rejects.toThrow("No open tab")
    expect(events.errors).toEqual([])
  })
})
