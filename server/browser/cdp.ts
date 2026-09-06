import { WebSocket } from "ws"
import type { FrameHeader } from "../../shared/browser/frames"
import type { BrowserClientMessage, BrowserServerMessage, BrowserTab } from "../../shared/browser/protocol"
import { resolveNavigationUrl } from "../../shared/browser/url"

type CdpParams = Record<string, unknown>
type CdpEventHandler = (params: CdpParams, sessionId?: string) => void

interface PendingCall {
  resolve: (result: CdpParams) => void
  reject: (error: Error) => void
}

const CONNECTION_CLOSED = "CDP connection closed"
const HANDSHAKE_TIMEOUT_MS = 5000
/**
 * A target that completed the handshake and then stopped answering would
 * otherwise hold every caller — and the socket under them — open for good.
 */
const CALL_TIMEOUT_MS = 10_000

/** Minimal JSON-RPC client over one CDP WebSocket. Session-scoped traffic carries a top-level `sessionId`. */
export class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private readonly handlers = new Map<string, Set<CdpEventHandler>>()
  private readonly closeHandlers = new Set<(reason: string) => void>()
  private closeReason: string | null = null

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.receive(data.toString()))
    socket.on("close", (code, reason) => this.handleClose(reason.toString() || `socket closed (${code})`))
  }

  static connect(wsUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
      socket.once("error", reject)
      socket.once("open", () => {
        socket.off("error", reject)
        // "close" follows every error; nothing to do here beyond keeping the emitter from throwing.
        socket.on("error", () => {})
        resolve(new CdpConnection(socket))
      })
    })
  }

  send<T = CdpParams>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(CONNECTION_CLOSED))
    const id = this.nextId++
    const message: CdpParams = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} did not answer in ${CALL_TIMEOUT_MS / 1_000}s`))
      }, CALL_TIMEOUT_MS)
      timer.unref?.()
      const settle = (finish: () => void): void => {
        clearTimeout(timer)
        finish()
      }
      this.pending.set(id, {
        resolve: (result) => settle(() => resolve(result as T)),
        reject: (error) => settle(() => reject(error)),
      })
      this.socket.send(JSON.stringify(message), (error) => {
        if (error && this.pending.delete(id)) settle(() => reject(error))
      })
    })
  }

  on(method: string, handler: CdpEventHandler): void {
    let set = this.handlers.get(method)
    if (!set) {
      set = new Set()
      this.handlers.set(method, set)
    }
    set.add(handler)
  }

  off(method: string, handler: CdpEventHandler): void {
    this.handlers.get(method)?.delete(handler)
  }

  /** Fires once, immediately if the connection is already gone. */
  onClose(handler: (reason: string) => void): void {
    if (this.closeReason !== null) handler(this.closeReason)
    else this.closeHandlers.add(handler)
  }

  close(): void {
    this.socket.close()
  }

  private receive(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) return
    const { id, method, params, result, error, sessionId } = message as CdpParams

    if (typeof id === "number") {
      const call = this.pending.get(id)
      if (!call) return
      this.pending.delete(id)
      if (error) call.reject(new Error(describeError(error)))
      else call.resolve(isParams(result) ? result : {})
      return
    }

    if (typeof method !== "string") return
    for (const handler of this.handlers.get(method) ?? []) {
      try {
        handler(isParams(params) ? params : {}, typeof sessionId === "string" ? sessionId : undefined)
      } catch {
        // one handler failing must not stop dispatch or take the socket down
      }
    }
  }

  private handleClose(reason: string): void {
    this.closeReason = reason
    const error = new Error(CONNECTION_CLOSED)
    for (const call of this.pending.values()) call.reject(error)
    this.pending.clear()
    for (const handler of this.closeHandlers) handler(reason)
    this.closeHandlers.clear()
  }
}

function isParams(value: unknown): value is CdpParams {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  if (isParams(error) && typeof error.message === "string") {
    return typeof error.data === "string" ? `${error.message}: ${error.data}` : error.message
  }
  return "CDP error"
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface TargetInfo {
  targetId: string
  type: string
  url: string
  title: string
}

interface NavigationHistory {
  currentIndex: number
  entries: { id: number }[]
}

interface PageTarget {
  sessionId: string
  url: string
  title: string
}

interface ScreencastSize {
  maxWidth: number
  maxHeight: number
}

/** The panel's own box, in CSS pixels, as the viewer last measured it. */
interface PanelSize {
  width: number
  height: number
  dpr: number
}

/** `Emulation.setDeviceMetricsOverride`'s size for the followed page. */
interface PageMetrics {
  width: number
  height: number
  deviceScaleFactor: number
}

interface ActiveOverride extends PageMetrics {
  sessionId: string
}

/** `Page.getLayoutMetrics`. `cssLayoutViewport` is the CSS-pixel one; older builds only send `layoutViewport`. */
interface LayoutMetrics {
  cssLayoutViewport?: { clientWidth: number; clientHeight: number }
  layoutViewport?: { clientWidth: number; clientHeight: number }
}

/** Chromium always sends the sizes; the scroll/scale fields are optional in older builds. */
interface ScreencastMetadata {
  deviceWidth: number
  deviceHeight: number
  pageScaleFactor?: number
  offsetTop?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
}

interface ActiveScreencast extends ScreencastSize {
  sessionId: string
}

type ClientMessage<T extends BrowserClientMessage["type"]> = Extract<BrowserClientMessage, { type: T }>
export type PageInfo = Omit<Extract<BrowserServerMessage, { type: "page" }>, "type">

export interface ViewerEvents {
  /**
   * Resolve once the frame is flushed to the viewer. Chromium caps the frames
   * it keeps in flight and waits for the ack, so a promise that settles late is
   * the only backpressure there is: a slow viewer throttles the browser instead
   * of growing an unbounded send buffer.
   */
  frame(header: FrameHeader, jpeg: Uint8Array): void | Promise<void>
  tabs(tabs: BrowserTab[], followed: string | null): void
  page(info: PageInfo): void
  /** Something failed off the request path — a target event, a screencast start, a frame flush. */
  error(message: string): void
  closed(reason: string): void
}

const EMPTY_PAGE: PageInfo = { targetId: "", url: "", title: "", canGoBack: false, canGoForward: false }
const MAX_SCREENCAST_SIZE = 1920
const MIN_DPR = 1
const MAX_DPR = 2
/** Below this the page lays itself out for a phone, which is not what a narrow panel wants. */
const MIN_PAGE_WIDTH = 1024
const MAX_PAGE_SIZE = 4096
const SCREENCAST_QUALITY = 80
const HIDDEN_URL_PREFIXES = ["devtools://", "chrome-extension://"]

const MOUSE_EVENT_TYPES: Record<ClientMessage<"mouse">["event"], string> = {
  move: "mouseMoved",
  down: "mousePressed",
  up: "mouseReleased",
}

/** `Input.dispatchMouseEvent.buttons` bits. Without them Blink reads a drag as a hover. */
const MOUSE_BUTTON_MASKS: Record<ClientMessage<"mouse">["button"], number> = {
  left: 1,
  right: 2,
  middle: 4,
  none: 0,
}

const MODIFIER_META = 4
const MODIFIER_SHIFT = 8

/** Keys whose page-side effect (submit, delete, caret moves) needs the virtual key code, not just `key`. */
const NAMED_KEY_CODES = new Map<string, number>([
  ["Backspace", 8],
  ["Tab", 9],
  ["Enter", 13],
  ["Escape", 27],
  ["Space", 32],
  ["PageUp", 33],
  ["PageDown", 34],
  ["End", 35],
  ["Home", 36],
  ["ArrowLeft", 37],
  ["ArrowUp", 38],
  ["ArrowRight", 39],
  ["ArrowDown", 40],
  ["Delete", 46],
])
const LETTER_CODE_RE = /^Key([A-Z])$/
const DIGIT_CODE_RE = /^Digit([0-9])$/

/** Blink runs macOS editor shortcuts from `commands`, not from the Meta-modified key event. */
const MAC_EDITING_COMMANDS = new Map<string, string>([
  ["a", "selectAll"],
  ["c", "copy"],
  ["v", "paste"],
  ["x", "cut"],
  ["z", "undo"],
  ["y", "redo"],
])

function virtualKeyCode(code: string): number | undefined {
  const letter = LETTER_CODE_RE.exec(code)
  if (letter) return letter[1].charCodeAt(0)
  const digit = DIGIT_CODE_RE.exec(code)
  if (digit) return 48 + Number(digit[1])
  return NAMED_KEY_CODES.get(code)
}

function macEditingCommands(key: string, modifiers: number): string[] | undefined {
  if (process.platform !== "darwin" || (modifiers & MODIFIER_META) === 0) return undefined
  const pressed = key.toLowerCase()
  if (pressed === "z" && (modifiers & MODIFIER_SHIFT) !== 0) return ["redo"]
  const command = MAC_EDITING_COMMANDS.get(pressed)
  return command === undefined ? undefined : [command]
}

function isPageTarget(info: TargetInfo): boolean {
  return info.type === "page" && !HIDDEN_URL_PREFIXES.some((prefix) => info.url.startsWith(prefix))
}

function clampDpr(dpr: number): number {
  return Math.min(MAX_DPR, Math.max(MIN_DPR, dpr))
}

/** The panel's device pixels, capped so a huge pane cannot ask for a huge stream. */
function screencastSize({ width, height, dpr }: PanelSize): ScreencastSize {
  const scale = clampDpr(dpr)
  return {
    maxWidth: Math.min(MAX_SCREENCAST_SIZE, Math.round(width * scale)),
    maxHeight: Math.min(MAX_SCREENCAST_SIZE, Math.round(height * scale)),
  }
}

/**
 * The page renders at the panel's aspect ratio, so the viewer's `fitRect` fills
 * the pane instead of letterboxing it. A panel narrower than `MIN_PAGE_WIDTH`
 * scales up to that floor, keeping the ratio, so the page stays a desktop page.
 */
function pageMetrics({ width, height, dpr }: PanelSize): PageMetrics | null {
  if (width <= 0 || height <= 0) return null
  const emulatedWidth = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_WIDTH, Math.round(width)))
  return {
    width: emulatedWidth,
    height: Math.min(MAX_PAGE_SIZE, Math.round(height * emulatedWidth / width)),
    deviceScaleFactor: clampDpr(dpr),
  }
}

/**
 * One viewer per socket client. Follows the most recently created page target
 * until `follow()` pins one; a pinned tab stays followed until it is destroyed,
 * after which the newest remaining tab takes over. Target bookkeeping, the
 * followed page's emulated size and screencast start/stop run on one serial
 * queue, so none of them can land on a session that has already detached.
 */
export class BrowserViewer {
  private readonly targets = new Map<string, PageTarget>()
  private followed: string | null = null
  private pinned = false
  private ready = false
  private closed = false
  private panel: PanelSize | null = null
  private screencast: ActiveScreencast | null = null
  private override: ActiveOverride | null = null
  private readonly captured = new Map<string, PageMetrics>()
  private buttons = 0
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(private readonly cdp: CdpConnection, private readonly events: ViewerEvents) {}

  static async open(browserWsUrl: string, events: ViewerEvents): Promise<BrowserViewer> {
    const cdp = await CdpConnection.connect(browserWsUrl)
    const viewer = new BrowserViewer(cdp, events)
    try {
      await viewer.start()
    } catch (error) {
      cdp.close()
      throw error
    }
    cdp.onClose((reason) => {
      if (!viewer.closed) events.closed(reason)
    })
    return viewer
  }

  setViewport(width: number, height: number, dpr: number): Promise<void> {
    this.panel = { width, height, dpr }
    return this.enqueue(() => this.syncFollowed())
  }

  follow(targetId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.targets.has(targetId)) throw new Error(`Unknown tab ${targetId}`)
      await this.setFollowed(targetId)
      this.pinned = true
    })
  }

  async mouse(msg: ClientMessage<"mouse">): Promise<void> {
    const { event, x, y, button, clickCount, modifiers } = msg
    const mask = MOUSE_BUTTON_MASKS[button]
    if (event === "down") this.buttons |= mask
    else if (event === "up") this.buttons &= ~mask
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { type: MOUSE_EVENT_TYPES[event], x, y, button, clickCount, modifiers, buttons: this.buttons },
      this.followedSession(),
    )
  }

  async wheel(msg: ClientMessage<"wheel">): Promise<void> {
    const { x, y, deltaX, deltaY, modifiers } = msg
    await this.cdp.send(
      "Input.dispatchMouseEvent",
      { type: "mouseWheel", x, y, deltaX, deltaY, modifiers, buttons: this.buttons },
      this.followedSession(),
    )
  }

  async key(msg: ClientMessage<"key">): Promise<void> {
    const { event, key, code, text, modifiers } = msg
    const type = event === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown"
    const params: CdpParams = { type, key, code, modifiers }
    if (type === "keyDown") params.text = text
    const keyCode = virtualKeyCode(code)
    if (keyCode !== undefined) {
      params.windowsVirtualKeyCode = keyCode
      params.nativeVirtualKeyCode = keyCode
    }
    if (event === "down") {
      const commands = macEditingCommands(key, modifiers)
      if (commands !== undefined) params.commands = commands
    }
    await this.cdp.send("Input.dispatchKeyEvent", params, this.followedSession())
  }

  async navigate(url: string): Promise<void> {
    const resolved = resolveNavigationUrl(url)
    await this.cdp.send("Page.navigate", { url: resolved }, this.followedSession())
  }

  back(): Promise<void> {
    return this.stepHistory(-1)
  }

  forward(): Promise<void> {
    return this.stepHistory(1)
  }

  async reload(): Promise<void> {
    await this.cdp.send("Page.reload", {}, this.followedSession())
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.buttons = 0
    try {
      const active = this.screencast
      if (active) await this.stopScreencast(active.sessionId)
      const emulated = this.override
      if (emulated) await this.restoreMetrics(emulated.sessionId)
    } finally {
      // Tidying up is best effort; letting go of the socket is not.
      this.cdp.close()
    }
  }

  private async start(): Promise<void> {
    this.cdp.on("Target.targetCreated", (params) => {
      const { targetInfo } = params as { targetInfo: TargetInfo }
      this.report(this.enqueue(() => this.onTargetCreated(targetInfo)))
    })
    this.cdp.on("Target.targetInfoChanged", (params) => {
      const { targetInfo } = params as { targetInfo: TargetInfo }
      this.report(this.enqueue(() => this.onTargetInfoChanged(targetInfo)))
    })
    this.cdp.on("Target.targetDestroyed", (params) => {
      const { targetId } = params as { targetId: string }
      this.report(this.enqueue(() => this.dropTarget(targetId)))
    })
    this.cdp.on("Target.detachedFromTarget", (params) => {
      const { targetId, sessionId } = params as { targetId?: string; sessionId?: string }
      this.report(this.enqueue(() => this.onDetached(targetId, sessionId)))
    })
    this.cdp.on("Inspector.targetCrashed", (_params, sessionId) => {
      this.report(this.enqueue(() => this.onDetached(undefined, sessionId)))
    })
    this.cdp.on("Page.screencastFrame", (params, sessionId) => {
      this.report(this.onScreencastFrame(params, sessionId))
    })
    this.cdp.on("Page.frameNavigated", (params, sessionId) => {
      const { frame } = params as { frame: { parentId?: string; url: string } }
      if (frame.parentId !== undefined) return
      this.report(this.enqueue(() => this.onMainFrameNavigated(frame.url, sessionId)))
    })

    await this.cdp.send("Target.setDiscoverTargets", { discover: true })
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets")
    await this.enqueue(async () => {
      for (const info of targetInfos) await this.attach(info).catch((error: unknown) => this.reportError(error))
      this.ready = true
      await this.setFollowed(this.newestTarget(), true)
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => {})
    return run
  }

  /** Work that no caller is awaiting still has to reach the viewer when it fails. */
  private report(work: Promise<unknown>): void {
    work.catch((error: unknown) => this.reportError(error))
  }

  private reportError(error: unknown): void {
    if (!this.closed) this.events.error(messageOf(error))
  }

  private followedSession(): string {
    const target = this.followed === null ? undefined : this.targets.get(this.followed)
    if (!target) throw new Error("No open tab")
    return target.sessionId
  }

  private newestTarget(): string | null {
    let newest: string | null = null
    for (const targetId of this.targets.keys()) newest = targetId
    return newest
  }

  private targetForSession(sessionId: string | undefined): string | null {
    for (const [targetId, target] of this.targets) {
      if (target.sessionId === sessionId) return targetId
    }
    return null
  }

  /** Resolves false for non-page targets and ones already attached. */
  private async attach(info: TargetInfo): Promise<boolean> {
    if (!isPageTarget(info) || this.targets.has(info.targetId)) return false
    const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: info.targetId, flatten: true })
    await this.cdp.send("Page.enable", {}, sessionId)
    this.targets.set(info.targetId, { sessionId, url: info.url, title: info.title })
    return true
  }

  private async onTargetCreated(info: TargetInfo): Promise<void> {
    if (!(await this.attach(info)) || !this.ready) return
    if (this.pinned) this.emitTabs()
    else await this.setFollowed(info.targetId)
  }

  private async onTargetInfoChanged(info: TargetInfo): Promise<void> {
    const target = this.targets.get(info.targetId)
    // A tab that navigates into devtools:// stops being ours to show; one that
    // navigates back out of an extension page is ours again.
    if (!target) {
      await this.onTargetCreated(info)
      return
    }
    if (!isPageTarget(info)) {
      await this.stopScreencast(target.sessionId)
      await this.restoreMetrics(target.sessionId)
      await this.dropTarget(info.targetId)
      return
    }
    if (target.url === info.url && target.title === info.title) return
    target.url = info.url
    target.title = info.title
    this.emitTabs()
    if (info.targetId === this.followed) await this.emitPage()
  }

  private async onDetached(targetId: string | undefined, sessionId: string | undefined): Promise<void> {
    const detached = targetId ?? this.targetForSession(sessionId)
    if (detached) await this.dropTarget(detached)
  }

  /** Forgets a target without talking to it: its session is already unusable. */
  private async dropTarget(targetId: string): Promise<void> {
    const target = this.targets.get(targetId)
    if (!target) return
    this.targets.delete(targetId)
    if (this.screencast?.sessionId === target.sessionId) this.screencast = null
    if (this.override?.sessionId === target.sessionId) this.override = null
    this.captured.delete(target.sessionId)
    if (targetId !== this.followed) {
      this.emitTabs()
      return
    }
    this.pinned = false
    this.followed = null
    await this.setFollowed(this.newestTarget(), true)
  }

  private async onMainFrameNavigated(url: string, sessionId: string | undefined): Promise<void> {
    const targetId = this.targetForSession(sessionId)
    if (targetId === null) return
    this.targets.get(targetId)!.url = url
    if (targetId === this.followed) await this.emitPage()
  }

  private async onScreencastFrame(params: CdpParams, sessionId: string | undefined): Promise<void> {
    const { data, metadata, sessionId: screencastSessionId } = params as {
      data: string
      metadata: ScreencastMetadata
      sessionId: number
    }
    const targetId = this.targetForSession(sessionId)
    if (targetId !== null && targetId === this.followed) {
      const header: FrameHeader = {
        deviceWidth: metadata.deviceWidth,
        deviceHeight: metadata.deviceHeight,
        pageScaleFactor: metadata.pageScaleFactor ?? 1,
        offsetTop: metadata.offsetTop ?? 0,
        scrollOffsetX: metadata.scrollOffsetX ?? 0,
        scrollOffsetY: metadata.scrollOffsetY ?? 0,
        targetId,
        ts: Date.now(),
      }
      try {
        await this.events.frame(header, Buffer.from(data, "base64"))
      } catch (error) {
        // A viewer that cannot take this frame must not wedge the stream: ack anyway.
        this.reportError(error)
      }
    }
    await this.cdp.send("Page.screencastFrameAck", { sessionId: screencastSessionId }, sessionId)
  }

  /** `force` emits even when the followed id is unchanged, for the initial state and after a destroy. */
  private async setFollowed(targetId: string | null, force = false): Promise<void> {
    if (!force && this.followed === targetId) return
    this.followed = targetId
    await this.syncFollowed()
    this.emitTabs()
    await this.emitPage()
  }

  /** The emulated size has to land before the screencast reads the page's box. */
  private async syncFollowed(): Promise<void> {
    try {
      await this.syncMetrics()
    } catch (error) {
      // A page that refuses the override still streams, letterboxed: report and go on.
      this.reportError(error)
    }
    await this.syncScreencast()
  }

  private async syncMetrics(): Promise<void> {
    if (this.closed) return
    const target = this.followed === null ? undefined : this.targets.get(this.followed)
    const metrics = this.panel === null ? null : pageMetrics(this.panel)
    const wanted: ActiveOverride | null = target && metrics ? { sessionId: target.sessionId, ...metrics } : null
    const active = this.override
    if (
      active && wanted && active.sessionId === wanted.sessionId
      && active.width === wanted.width && active.height === wanted.height
      && active.deviceScaleFactor === wanted.deviceScaleFactor
    ) {
      return
    }
    // A target we stop following goes back to its own size; one we keep just gets the new box.
    if (active && active.sessionId !== wanted?.sessionId) await this.restoreMetrics(active.sessionId)
    if (!wanted) return
    await this.captureMetrics(wanted.sessionId)
    await this.cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: wanted.width,
        height: wanted.height,
        deviceScaleFactor: wanted.deviceScaleFactor,
        mobile: false,
        screenWidth: wanted.width,
        screenHeight: wanted.height,
      },
      wanted.sessionId,
    )
    this.override = wanted
  }

  /**
   * Reads what a target renders at before our first override lands on it. The
   * emulation slot is per target, not per CDP client, so this is the automation's
   * own viewport and we have to hand it back rather than clear the slot.
   */
  private async captureMetrics(sessionId: string): Promise<void> {
    if (this.captured.has(sessionId)) return
    try {
      const metrics = await this.cdp.send<LayoutMetrics>("Page.getLayoutMetrics", {}, sessionId)
      const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport
      if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return
      const deviceScaleFactor = await this.devicePixelRatio(sessionId)
      this.captured.set(sessionId, { width: viewport.clientWidth, height: viewport.clientHeight, deviceScaleFactor })
    } catch {
      // Nothing read means nothing to restore, and the stop path clears instead.
    }
  }

  private async devicePixelRatio(sessionId: string): Promise<number> {
    try {
      const { result } = await this.cdp.send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: "window.devicePixelRatio", returnByValue: true },
        sessionId,
      )
      const value = result?.value
      return typeof value === "number" && value > 0 ? value : 1
    } catch {
      return 1
    }
  }

  /**
   * Hands the target back what `captureMetrics` read, and only clears the slot
   * when nothing was read. No-op unless `sessionId` owns the override: a tab that
   * already went away cannot answer either way.
   */
  private async restoreMetrics(sessionId: string): Promise<void> {
    if (this.override?.sessionId !== sessionId) return
    this.override = null
    const previous = this.captured.get(sessionId)
    this.captured.delete(sessionId)
    const request = previous
      ? this.cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: previous.width, height: previous.height, deviceScaleFactor: previous.deviceScaleFactor, mobile: false },
        sessionId,
      )
      : this.cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId)
    await request.catch(() => {})
  }

  private async syncScreencast(): Promise<void> {
    if (this.closed) return
    const target = this.followed === null ? undefined : this.targets.get(this.followed)
    const wanted: ActiveScreencast | null = target && this.panel
      ? { sessionId: target.sessionId, ...screencastSize(this.panel) }
      : null
    const active = this.screencast
    if (
      active && wanted && active.sessionId === wanted.sessionId
      && active.maxWidth === wanted.maxWidth && active.maxHeight === wanted.maxHeight
    ) {
      return
    }
    if (active) await this.stopScreencast(active.sessionId)
    if (!wanted) return
    this.screencast = wanted
    try {
      await this.cdp.send(
        "Page.startScreencast",
        { format: "jpeg", quality: SCREENCAST_QUALITY, maxWidth: wanted.maxWidth, maxHeight: wanted.maxHeight, everyNthFrame: 1 },
        wanted.sessionId,
      )
    } catch (error) {
      // Nothing is streaming, so leave nothing pinned: the next sync retries
      // instead of freezing the viewer on the last frame.
      this.screencast = null
      throw error
    }
  }

  /** No-op unless `sessionId` owns the active screencast. A tab that already went away cannot answer. */
  private async stopScreencast(sessionId: string): Promise<void> {
    if (this.screencast?.sessionId !== sessionId) return
    this.screencast = null
    await this.cdp.send("Page.stopScreencast", {}, sessionId).catch(() => {})
  }

  private async stepHistory(delta: number): Promise<void> {
    const sessionId = this.followedSession()
    const { currentIndex, entries } = await this.cdp.send<NavigationHistory>("Page.getNavigationHistory", {}, sessionId)
    const entry = entries[currentIndex + delta]
    if (!entry) return
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId)
  }

  private emitTabs(): void {
    const tabs = Array.from(this.targets, ([targetId, { url, title }]) => ({ targetId, url, title }))
    this.events.tabs(tabs, this.followed)
  }

  private async emitPage(): Promise<void> {
    const targetId = this.followed
    const target = targetId === null ? undefined : this.targets.get(targetId)
    if (targetId === null || !target) {
      this.events.page(EMPTY_PAGE)
      return
    }
    let canGoBack = false
    let canGoForward = false
    try {
      const { currentIndex, entries } = await this.cdp.send<NavigationHistory>("Page.getNavigationHistory", {}, target.sessionId)
      canGoBack = currentIndex > 0
      canGoForward = currentIndex < entries.length - 1
    } catch {
      // a tab that is already gone reports no history; targetDestroyed follows
    }
    this.events.page({ targetId, url: target.url, title: target.title, canGoBack, canGoForward })
  }
}
