// @vitest-environment node
import { EventEmitter } from "node:events"
import type { IncomingMessage } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import type { ViewerEvents } from "../../browser/cdp"
import { defaultDaemonDeps, launch as launchBrowser } from "../../browser/daemons"
import {
  BrowserViewerManager,
  type BrowserViewerLike,
  type ViewerSocketDeps,
} from "../../browser/viewerSocket"
import { decodeFrame, type FrameHeader } from "../../../shared/browser/frames"
import type { BrowserClientMessage, BrowserServerMessage } from "../../../shared/browser/protocol"

const OPEN = 1
const CLOSED = 3

const HEADER: FrameHeader = {
  deviceWidth: 800,
  deviceHeight: 600,
  pageScaleFactor: 1,
  offsetTop: 0,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
  targetId: "t1",
  ts: 1234,
}
const JPEG = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])

class FakeSocket extends EventEmitter {
  readyState = OPEN
  readonly sent: (string | Uint8Array)[] = []
  readonly closes: { code: number; reason: string }[] = []
  private readonly pending: (() => void)[] = []

  send(data: string | Uint8Array, callback?: () => void): void {
    this.sent.push(data)
    if (callback) this.pending.push(callback)
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSED) return
    this.closes.push({ code, reason })
    this.readyState = CLOSED
    this.emit("close")
  }

  /** Run the send callbacks the manager is waiting on. */
  flush(): void {
    for (const callback of this.pending.splice(0)) callback()
  }

  get waiting(): number {
    return this.pending.length
  }

  receive(message: BrowserClientMessage | string): void {
    this.emit("message", Buffer.from(typeof message === "string" ? message : JSON.stringify(message)))
  }

  messages(): BrowserServerMessage[] {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data) as BrowserServerMessage)
  }

  statuses(): string[] {
    return this.messages().flatMap((message) => (message.type === "status" ? [message.state] : []))
  }

  errors(): string[] {
    return this.messages().flatMap((message) => (message.type === "error" ? [message.message] : []))
  }

  frames(): Uint8Array[] {
    return this.sent.filter((data): data is Uint8Array => typeof data !== "string")
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket
  }
}

class FakeViewer implements BrowserViewerLike {
  readonly calls: { method: string; args: unknown[] }[] = []
  closeCount = 0
  rejectWith: Error | null = null

  setViewport(width: number, height: number, dpr: number): Promise<void> {
    return this.record("setViewport", width, height, dpr)
  }

  follow(targetId: string): Promise<void> {
    return this.record("follow", targetId)
  }

  closeTab(targetId: string): Promise<void> {
    return this.record("closeTab", targetId)
  }

  mouse(message: Extract<BrowserClientMessage, { type: "mouse" }>): Promise<void> {
    return this.record("mouse", message)
  }

  wheel(message: Extract<BrowserClientMessage, { type: "wheel" }>): Promise<void> {
    return this.record("wheel", message)
  }

  key(message: Extract<BrowserClientMessage, { type: "key" }>): Promise<void> {
    return this.record("key", message)
  }

  navigate(url: string): Promise<void> {
    return this.record("navigate", url)
  }

  back(): Promise<void> {
    return this.record("back")
  }

  forward(): Promise<void> {
    return this.record("forward")
  }

  reload(): Promise<void> {
    return this.record("reload")
  }

  close(): Promise<void> {
    this.closeCount += 1
    return Promise.resolve()
  }

  names(): string[] {
    return this.calls.map((call) => call.method)
  }

  private record(method: string, ...args: unknown[]): Promise<void> {
    this.calls.push({ method, args })
    return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve()
  }
}

interface OpenedViewer {
  url: string
  events: ViewerEvents
  viewer: FakeViewer
}

function request(query = "?session=default"): IncomingMessage {
  return { url: `/__browser${query}` } as IncomingMessage
}

/** Every harness is torn down in `afterEach`, so a failing assertion cannot leak timers. */
const managers: BrowserViewerManager[] = []

function makeHarness(overrides: Partial<ViewerSocketDeps> = {}) {
  const opened: OpenedViewer[] = []
  const controls = {
    installed: true,
    running: false,
    endpoint: (name: string): { browserWsUrl: string } | null => ({
      browserWsUrl: `ws://127.0.0.1:9222/devtools/browser/${name}`,
    }),
  }
  const calls = {
    isRunning: 0,
    launched: [] as [string, string][],
    recorded: [] as [string, string][],
  }
  const deps: ViewerSocketDeps = {
    installed: () => controls.installed,
    isRunning: async () => {
      calls.isRunning += 1
      return controls.running
    },
    endpoint: (name) => controls.endpoint(name),
    openViewer: async (url, events) => {
      const viewer = new FakeViewer()
      opened.push({ url, events, viewer })
      return viewer
    },
    launch: async (name, url) => {
      calls.launched.push([name, url])
      controls.running = true
    },
    recordUrl: (name, url) => {
      calls.recorded.push([name, url])
    },
    ...overrides,
  }
  const manager = new BrowserViewerManager(deps)
  managers.push(manager)
  return {
    manager,
    controls,
    calls,
    opened,
    last(): OpenedViewer {
      const record = opened.at(-1)
      if (!record) throw new Error("no viewer was opened")
      return record
    },
    connect(query?: string): FakeSocket {
      const ws = new FakeSocket()
      manager.handleConnection(ws.asWebSocket(), request(query))
      return ws
    },
  }
}

/** Let the manager's promise chain (isRunning → openViewer → status) run out. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

async function connectLive(harness: ReturnType<typeof makeHarness>): Promise<FakeSocket> {
  harness.controls.running = true
  const ws = harness.connect()
  await settle()
  return ws
}

describe("BrowserViewerManager", () => {
  let harness: ReturnType<typeof makeHarness>

  beforeEach(() => {
    vi.useFakeTimers()
    harness = makeHarness()
  })

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.cleanup()
    vi.useRealTimers()
  })

  describe("session name", () => {
    it.each([
      ["missing", ""],
      ["empty", "?session="],
      ["traversal", "?session=../x"],
      ["uppercase", "?session=Foo"],
      ["throwaway", "?session=tmp-1"],
    ])("rejects a %s session name with 1008", async (_label, query) => {
      const ws = harness.connect(query)
      await settle()

      expect(ws.errors()).toHaveLength(1)
      expect(ws.closes).toEqual([{ code: 1008, reason: expect.any(String) }])
      expect(harness.calls.isRunning).toBe(0)
    })

    it("rejects a request target that cannot be parsed as a url", async () => {
      const ws = new FakeSocket()
      harness.manager.handleConnection(ws.asWebSocket(), { url: "//[" } as IncomingMessage)
      await settle()

      expect(ws.errors()).toHaveLength(1)
      expect(ws.closes).toEqual([{ code: 1008, reason: expect.any(String) }])
      expect(harness.calls.isRunning).toBe(0)
    })

    it("accepts a valid name and reports it in every status", async () => {
      harness.controls.running = true
      const ws = harness.connect("?session=github")
      await settle()

      const statuses = ws.messages().filter((message) => message.type === "status")
      expect(statuses.every((message) => message.session === "github")).toBe(true)
      expect(harness.last().url).toBe("ws://127.0.0.1:9222/devtools/browser/github")
    })
  })

  describe("lifecycle", () => {
    it("reports not-installed and stops there", async () => {
      harness.controls.installed = false
      const ws = harness.connect()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(ws.statuses()).toEqual(["not-installed"])
      expect(harness.calls.isRunning).toBe(0)
      expect(harness.opened).toHaveLength(0)
    })

    it("waits in stopped, polls, and goes live when the browser appears", async () => {
      const ws = harness.connect()
      await settle()
      expect(ws.statuses()).toEqual(["stopped"])

      await vi.advanceTimersByTimeAsync(2_000)
      expect(harness.calls.isRunning).toBe(2)
      expect(ws.statuses()).toEqual(["stopped"])

      harness.controls.running = true
      await vi.advanceTimersByTimeAsync(2_000)

      expect(ws.statuses()).toEqual(["stopped", "connecting", "live"])
      expect(harness.opened).toHaveLength(1)
    })

    it("stops polling once live", async () => {
      await connectLive(harness)
      const polls = harness.calls.isRunning

      await vi.advanceTimersByTimeAsync(10_000)

      expect(harness.calls.isRunning).toBe(polls)
      expect(harness.opened).toHaveLength(1)
    })

    it("returns to stopped and resumes polling when the viewer closes", async () => {
      const ws = await connectLive(harness)
      harness.controls.running = false
      harness.last().events.closed("browser exited")
      await settle()

      expect(ws.statuses()).toEqual(["connecting", "live", "stopped"])

      harness.controls.running = true
      await vi.advanceTimersByTimeAsync(2_000)

      expect(ws.statuses()).toEqual(["connecting", "live", "stopped", "connecting", "live"])
      expect(harness.opened).toHaveLength(2)
    })

    it("reports a failed attach and falls back to polling", async () => {
      harness.controls.running = true
      harness.controls.endpoint = () => null
      const ws = harness.connect()
      await settle()

      expect(ws.statuses()).toEqual(["connecting", "stopped"])
      expect(ws.errors()).toHaveLength(1)

      harness.controls.endpoint = () => ({ browserWsUrl: "ws://127.0.0.1:9222/devtools/browser/retry" })
      await vi.advanceTimersByTimeAsync(2_000)

      expect(ws.statuses()).toEqual(["connecting", "stopped", "connecting", "live"])
    })

    it("attaches right after a launch instead of waiting for the poll", async () => {
      const ws = harness.connect()
      await settle()
      const polls = harness.calls.isRunning

      ws.receive({ type: "launch", url: "https://example.com" })
      await settle()

      expect(harness.calls.launched).toEqual([["default", "https://example.com"]])
      expect(ws.statuses()).toEqual(["stopped", "connecting", "live"])
      expect(harness.calls.isRunning).toBe(polls)
    })

    it("refuses a launch url the daemon would not open, and spawns nothing", async () => {
      const spawned: string[][] = []
      const guarded = makeHarness({
        launch: (name, url) => launchBrowser(name, url, undefined, {
          ...defaultDaemonDeps,
          spawn: async (_command, args) => {
            spawned.push(args)
            return { code: 0, stderr: "" }
          },
        }),
      })
      const ws = guarded.connect()
      await settle()

      ws.receive({ type: "launch", url: "file:///Users/x/.ssh/id_rsa" })
      await settle()

      expect(ws.errors()).toEqual(["Refusing to navigate to a file: url"])
      expect(spawned).toEqual([])
      expect(guarded.opened).toHaveLength(0)
      expect(ws.statuses()).toEqual(["stopped"])
    })

    it("does not re-attach when a launch arrives while the viewer is live", async () => {
      const ws = await connectLive(harness)

      ws.receive({ type: "launch", url: "https://example.com" })
      await settle()

      expect(harness.opened).toHaveLength(1)
      expect(ws.statuses()).toEqual(["connecting", "live"])
      expect(harness.last().viewer.closeCount).toBe(0)
    })

    it("reports an attach that keeps failing only once", async () => {
      harness.controls.running = true
      harness.controls.endpoint = () => null
      const ws = harness.connect()
      await settle()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(ws.errors()).toEqual(["default is not exposing a DevTools endpoint"])
      expect(harness.calls.isRunning).toBeGreaterThan(3)
    })

    it("replays the last viewport once the browser comes up", async () => {
      const ws = harness.connect()
      await settle()

      ws.receive({ type: "viewport", width: 1024, height: 768, dpr: 2 })
      await settle()
      expect(harness.opened).toHaveLength(0)

      harness.controls.running = true
      await vi.advanceTimersByTimeAsync(2_000)

      const viewer = harness.last().viewer
      expect(viewer.names()).toEqual(["setViewport"])
      expect(viewer.calls[0].args).toEqual([1024, 768, 2])
      expect(ws.statuses()).toEqual(["stopped", "connecting", "live"])
    })

    it("reports a failed launch and stays stopped", async () => {
      const failing = makeHarness({
        launch: async () => {
          throw new Error("no binary")
        },
      })
      const ws = failing.connect()
      await settle()

      ws.receive({ type: "launch", url: "https://example.com" })
      await settle()

      expect(ws.errors()).toEqual(["no binary"])
      expect(ws.statuses()).toEqual(["stopped"])
      expect(failing.opened).toHaveLength(0)
    })
  })

  describe("attach timeout", () => {
    function wedgedHarness() {
      let opens = 0
      let release: ((viewer: BrowserViewerLike) => void) | undefined
      const harness = makeHarness({
        openViewer: () => new Promise<BrowserViewerLike>((resolve) => {
          opens += 1
          release ??= resolve
        }),
      })
      harness.controls.running = true
      return { harness, releaseFirst: (viewer: BrowserViewerLike) => release?.(viewer), opens: () => opens }
    }

    it("gives up on a viewer that never answers and resumes polling", async () => {
      const wedged = wedgedHarness()
      const ws = wedged.harness.connect()
      await settle()
      expect(ws.statuses()).toEqual(["connecting"])

      await vi.advanceTimersByTimeAsync(10_000)

      expect(ws.statuses()).toEqual(["connecting", "stopped"])
      expect(ws.errors()).toEqual([expect.stringContaining("did not answer")])

      await vi.advanceTimersByTimeAsync(2_000)
      expect(wedged.opens()).toBe(2)
    })

    it("closes a viewer that answers after the timeout instead of adopting it", async () => {
      const wedged = wedgedHarness()
      const late = new FakeViewer()
      const ws = wedged.harness.connect()
      await settle()

      await vi.advanceTimersByTimeAsync(10_000)
      wedged.releaseFirst(late)
      await settle()

      expect(late.closeCount).toBe(1)
      expect(ws.statuses()).toEqual(["connecting", "stopped"])
    })
  })

  describe("frames", () => {
    it("encodes the frame and resolves only when the send flushes", async () => {
      const ws = await connectLive(harness)

      const pending = harness.last().events.frame(HEADER, JPEG)
      expect(pending).toBeInstanceOf(Promise)
      let flushed = false
      void Promise.resolve(pending).then(() => {
        flushed = true
      })
      await settle()

      expect(ws.frames()).toHaveLength(1)
      const decoded = decodeFrame(ws.frames()[0])
      expect(decoded.header).toEqual(HEADER)
      expect(Array.from(decoded.jpeg)).toEqual(Array.from(JPEG))
      expect(flushed).toBe(false)

      ws.flush()
      await settle()
      expect(flushed).toBe(true)
    })

    it("settles the frame promise when the socket dies mid-send", async () => {
      const ws = await connectLive(harness)

      let flushed = false
      void Promise.resolve(harness.last().events.frame(HEADER, JPEG)).then(() => {
        flushed = true
      })
      await settle()
      expect(flushed).toBe(false)

      ws.close()
      await settle()

      expect(flushed).toBe(true)
    })

    it("resolves immediately when the socket is no longer open", async () => {
      const ws = await connectLive(harness)
      const events = harness.last().events
      ws.close()

      const pending = events.frame(HEADER, JPEG)
      let flushed = false
      void Promise.resolve(pending).then(() => {
        flushed = true
      })
      await settle()

      expect(flushed).toBe(true)
      expect(ws.frames()).toHaveLength(0)
      expect(ws.waiting).toBe(0)
    })
  })

  describe("viewer events", () => {
    it("forwards tabs and page, and records the page url", async () => {
      const ws = await connectLive(harness)
      const events = harness.last().events

      events.tabs([{ targetId: "t1", url: "https://a.test/", title: "A" }], "t1")
      events.page({ targetId: "t1", url: "https://a.test/", title: "A", canGoBack: true, canGoForward: false })
      await settle()

      expect(ws.messages()).toContainEqual({
        type: "tabs",
        tabs: [{ targetId: "t1", url: "https://a.test/", title: "A" }],
        followed: "t1",
      })
      expect(ws.messages()).toContainEqual({
        type: "page",
        targetId: "t1",
        url: "https://a.test/",
        title: "A",
        canGoBack: true,
        canGoForward: false,
      })
      expect(harness.calls.recorded).toEqual([["default", "https://a.test/"]])
    })

    it("survives a throwing recordUrl", async () => {
      const throwing = makeHarness({
        recordUrl: () => {
          throw new Error("registry is read-only")
        },
      })
      throwing.controls.running = true
      const ws = throwing.connect()
      await settle()

      throwing.last().events.page({ targetId: "t1", url: "https://a.test/", title: "A", canGoBack: false, canGoForward: false })
      await settle()

      expect(ws.statuses()).toEqual(["connecting", "live"])
      expect(ws.errors()).toEqual([])
    })

    it("forwards a viewer error without tearing the connection down", async () => {
      const ws = await connectLive(harness)

      harness.last().events.error("screencast failed")
      await settle()

      expect(ws.errors()).toEqual(["screencast failed"])
      expect(ws.statuses()).toEqual(["connecting", "live"])
      expect(harness.last().viewer.closeCount).toBe(0)

      ws.receive({ type: "reload" })
      await settle()
      expect(harness.last().viewer.names()).toEqual(["reload"])
    })
  })

  describe("client messages", () => {
    it("forwards every input message to the viewer", async () => {
      const ws = await connectLive(harness)
      const viewer = harness.last().viewer

      const mouse = { type: "mouse", event: "down", x: 4, y: 8, button: "left", clickCount: 1, modifiers: 0 } as const
      const wheel = { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 120, modifiers: 0 } as const
      const key = { type: "key", event: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 } as const
      ws.receive({ type: "viewport", width: 900, height: 600, dpr: 2 })
      ws.receive(mouse)
      ws.receive(wheel)
      ws.receive(key)
      ws.receive({ type: "navigate", url: "example.com" })
      ws.receive({ type: "back" })
      ws.receive({ type: "forward" })
      ws.receive({ type: "reload" })
      ws.receive({ type: "follow", targetId: "t2" })
      ws.receive({ type: "close-tab", targetId: "t1" })
      await settle()

      expect(viewer.names()).toEqual([
        "setViewport", "mouse", "wheel", "key", "navigate", "back", "forward", "reload", "follow", "closeTab",
      ])
      expect(viewer.calls[0].args).toEqual([900, 600, 2])
      expect(viewer.calls[1].args).toEqual([mouse])
      expect(viewer.calls[2].args).toEqual([wheel])
      expect(viewer.calls[3].args).toEqual([key])
      expect(viewer.calls[4].args).toEqual(["example.com"])
      expect(viewer.calls[8].args).toEqual(["t2"])
      expect(viewer.calls[9].args).toEqual(["t1"])
      expect(ws.errors()).toEqual([])
    })

    it("ignores malformed and rejected messages", async () => {
      const ws = await connectLive(harness)
      const viewer = harness.last().viewer

      ws.receive("not json")
      ws.receive("[1,2,3]")
      ws.receive("{}")
      ws.receive({ type: "nonsense" } as unknown as BrowserClientMessage)
      ws.receive({ type: "viewport", width: 0, height: 600, dpr: 1 })
      ws.receive({ type: "mouse", event: "down", x: 1, y: 2, button: "left", clickCount: -1, modifiers: 0 })
      ws.receive({ type: "navigate", url: "" })
      await settle()

      expect(viewer.calls).toEqual([])
      expect(ws.errors()).toEqual([])
      expect(ws.statuses()).toEqual(["connecting", "live"])
    })

    it("ignores input before the viewer is live", async () => {
      const ws = harness.connect()
      await settle()

      ws.receive({ type: "reload" })
      await settle()

      expect(harness.opened).toHaveLength(0)
      expect(ws.errors()).toEqual([])
    })

    it("reports a rejected viewer call as an error", async () => {
      const ws = await connectLive(harness)
      harness.last().viewer.rejectWith = new Error("Unknown tab t9")

      ws.receive({ type: "follow", targetId: "t9" })
      await settle()

      expect(ws.errors()).toEqual(["Unknown tab t9"])
      expect(ws.statuses()).toEqual(["connecting", "live"])
    })
  })

  describe("authorization", () => {
    it("checks on every inbound message and on the recheck interval", async () => {
      const authorize = vi.fn(() => true)
      harness.controls.running = true
      const ws = new FakeSocket()
      harness.manager.handleConnection(ws.asWebSocket(), request(), authorize)
      await settle()

      ws.receive({ type: "reload" })
      await settle()
      expect(authorize).toHaveBeenCalledWith(true)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(authorize).toHaveBeenCalledWith(false)
      expect(ws.closes).toEqual([])
    })

    it("closes with 1008 when the recheck fails", async () => {
      let allowed = true
      harness.controls.running = true
      const ws = new FakeSocket()
      harness.manager.handleConnection(ws.asWebSocket(), request(), () => allowed)
      await settle()
      const viewer = harness.last().viewer

      allowed = false
      await vi.advanceTimersByTimeAsync(5_000)

      expect(ws.closes).toEqual([{ code: 1008, reason: expect.any(String) }])
      expect(viewer.closeCount).toBe(1)
    })

    it("closes when an inbound message is no longer authorized", async () => {
      harness.controls.running = true
      const ws = new FakeSocket()
      harness.manager.handleConnection(ws.asWebSocket(), request(), (touch) => !touch)
      await settle()
      const viewer = harness.last().viewer

      ws.receive({ type: "reload" })
      await settle()

      expect(viewer.calls).toEqual([])
      expect(ws.closes[0].code).toBe(1008)
    })

    it("stops sending before the next recheck once the authorizer says no", async () => {
      let allowed = true
      harness.controls.running = true
      const ws = new FakeSocket()
      harness.manager.handleConnection(ws.asWebSocket(), request(), () => allowed)
      await settle()
      const { events } = harness.last()
      const sentWhileLive = ws.sent.length

      allowed = false
      let flushed = false
      void Promise.resolve(events.frame(HEADER, JPEG)).then(() => {
        flushed = true
      })
      events.tabs([{ targetId: "t1", url: "https://a.test/", title: "A" }], "t1")
      await settle()

      expect(ws.frames()).toHaveLength(0)
      expect(ws.sent).toHaveLength(sentWhileLive)
      expect(flushed).toBe(true)
      expect(ws.closes).toEqual([{ code: 1008, reason: expect.any(String) }])
    })

    it("fails closed when the authorizer throws", async () => {
      harness.controls.running = true
      const ws = new FakeSocket()
      harness.manager.handleConnection(ws.asWebSocket(), request(), () => {
        throw new Error("token store is gone")
      })
      await settle()

      await vi.advanceTimersByTimeAsync(5_000)

      expect(ws.closes[0].code).toBe(1008)
    })
  })

  describe("teardown", () => {
    it("closes the viewer and clears the timers when the socket closes", async () => {
      const ws = await connectLive(harness)
      const viewer = harness.last().viewer

      ws.close()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(viewer.closeCount).toBe(1)
      expect(harness.calls.isRunning).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("stops polling when a stopped socket errors out", async () => {
      const ws = harness.connect()
      await settle()
      const polls = harness.calls.isRunning

      ws.emit("error", new Error("reset by peer"))
      await vi.advanceTimersByTimeAsync(10_000)

      expect(harness.calls.isRunning).toBe(polls)
      expect(vi.getTimerCount()).toBe(0)
    })

    it("closes a viewer that opened after the socket went away", async () => {
      let release: ((viewer: BrowserViewerLike) => void) | undefined
      const slow = new FakeViewer()
      const racing = makeHarness({
        openViewer: () => new Promise<BrowserViewerLike>((resolve) => {
          release = resolve
        }),
      })
      racing.controls.running = true
      const ws = racing.connect()
      await settle()
      expect(ws.statuses()).toEqual(["connecting"])

      ws.close()
      release?.(slow)
      await settle()

      expect(slow.closeCount).toBe(1)
      expect(ws.statuses()).toEqual(["connecting"])
    })

    it("keeps two connections on one session independent", async () => {
      const first = await connectLive(harness)
      const second = harness.connect()
      await settle()
      const [one, two] = harness.opened
      expect(harness.opened).toHaveLength(2)

      one.events.error("only the first")
      void one.events.frame(HEADER, JPEG)
      await settle()
      expect(second.errors()).toEqual([])
      expect(second.frames()).toHaveLength(0)

      first.close()
      await settle()
      expect(one.viewer.closeCount).toBe(1)
      expect(two.viewer.closeCount).toBe(0)

      second.receive({ type: "reload" })
      await settle()
      expect(two.viewer.names()).toEqual(["reload"])
    })

    it("cleanup closes every live connection and is idempotent", async () => {
      const first = await connectLive(harness)
      const second = harness.connect("?session=github")
      await settle()
      const viewers = harness.opened.map((record) => record.viewer)
      expect(viewers).toHaveLength(2)

      harness.manager.cleanup()
      harness.manager.cleanup()

      expect(viewers.map((viewer) => viewer.closeCount)).toEqual([1, 1])
      expect(first.closes).toEqual([{ code: 1001, reason: expect.any(String) }])
      expect(second.closes).toEqual([{ code: 1001, reason: expect.any(String) }])
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.calls.isRunning).toBe(2)
    })
  })
})
