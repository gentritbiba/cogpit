// @vitest-environment node
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const inputs = vi.hoisted(() => ({ follow: vi.fn(), stop: vi.fn() }))
vi.mock("../../sessionList/versionInputs", () => ({
  followVersionInputs: inputs.follow,
  stopFollowingVersionInputs: inputs.stop,
}))

import { PERSONAL_EDITION, __resetEditionForTest } from "../../edition"
import { catalogVersion, markCatalogChanged } from "../../sessionCatalog"
import { hasCatalogListeners } from "../../sessionCatalog/changes"
import {
  HEARTBEAT_MS,
  TOUCH_GAP_MS,
  VISIBLE_GAP_MS,
  __resetSessionListEventsForTest,
  handleSessionListEvents,
} from "../../sessionList/events"
import { installFakeEdition } from "../edition/fakeEdition"
import { LIST_EPOCH } from "../../sessionList/revalidate"
import { asIncomingMessage, asServerResponse } from "../http-fixtures"

class StreamResponse extends EventEmitter {
  chunks: string[] = []
  head: { status: number; headers: Record<string, string> } | null = null
  flushed = false
  writeHead(status: number, headers: Record<string, string>) {
    this.head = { status, headers }
    return this
  }
  flushHeaders() {
    this.flushed = true
  }
  write(chunk: string) {
    this.chunks.push(chunk)
    return true
  }
  /** Version numbers sent since the last call. */
  versions(): number[] {
    const sent = this.chunks.flatMap((chunk) => {
      const match = /^event: version\ndata: (.*)\n\n$/.exec(chunk)
      return match ? [(JSON.parse(match[1]!) as { version: number }).version] : []
    })
    this.chunks = []
    return sent
  }
}

function connect(url = "/") {
  const res = new StreamResponse()
  const next = vi.fn()
  handleSessionListEvents(asIncomingMessage({ method: "GET", url, headers: {} }), asServerResponse(res), next)
  return { res, next }
}

describe("GET /api/session-list/events", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    inputs.follow.mockClear()
    inputs.stop.mockClear()
  })

  afterEach(() => {
    __resetSessionListEventsForTest()
    __resetEditionForTest()
    vi.useRealTimers()
  })

  it("flushes its headers and sends the version on connect", () => {
    const { res } = connect()
    expect(res.head).toEqual({
      status: 200,
      headers: expect.objectContaining({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }),
    })
    expect(res.flushed).toBe(true)
    expect(res.versions()).toEqual([catalogVersion()])
  })

  it("leaves other methods and paths to the next handler", () => {
    expect(connect("/other").next).toHaveBeenCalled()
  })

  it("announces a visible change at once, then at most every 500 ms", () => {
    const { res } = connect()
    res.versions()
    markCatalogChanged("visible")
    vi.advanceTimersByTime(0)
    expect(res.versions()).toEqual([catalogVersion()])

    markCatalogChanged("visible")
    markCatalogChanged("visible")
    vi.advanceTimersByTime(VISIBLE_GAP_MS - 1)
    expect(res.versions()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(res.versions()).toEqual([catalogVersion()])
  })

  it("lets touch-only changes ride along at most every 15 s", () => {
    const { res } = connect()
    res.versions()
    markCatalogChanged("visible")
    vi.advanceTimersByTime(0)
    res.versions()

    markCatalogChanged("touch")
    vi.advanceTimersByTime(TOUCH_GAP_MS - 1)
    markCatalogChanged("touch")
    expect(res.versions()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(res.versions()).toEqual([catalogVersion()])
  })

  it("sends a visible change early even while a touch waits", () => {
    const { res } = connect()
    markCatalogChanged("visible")
    vi.advanceTimersByTime(0)
    res.versions()
    markCatalogChanged("touch")
    markCatalogChanged("visible")
    vi.advanceTimersByTime(VISIBLE_GAP_MS)
    expect(res.versions()).toEqual([catalogVersion()])
  })

  it("sends a heartbeat comment every 25 s", () => {
    const { res } = connect()
    res.chunks = []
    vi.advanceTimersByTime(HEARTBEAT_MS)
    expect(res.chunks).toEqual([": heartbeat\n\n"])
  })

  it("follows the catalog and the eventless inputs only while a client is connected", () => {
    const first = connect()
    const second = connect()
    expect(inputs.follow).toHaveBeenCalledTimes(1)
    expect(hasCatalogListeners()).toBe(true)

    first.res.emit("close")
    expect(inputs.stop).not.toHaveBeenCalled()
    second.res.emit("close")
    expect(inputs.stop).toHaveBeenCalledTimes(1)
    expect(hasCatalogListeners()).toBe(false)
  })

  it("tells a caller who sees no session the version, then nothing until they see one", () => {
    let seesNothing = true
    const visibility = () => Object.assign(async () => "hidden" as const, { everything: false, nothing: seesNothing })
    installFakeEdition({ access: { ...PERSONAL_EDITION.access, visibilityFor: visibility } })
    const { res } = connect()
    expect(res.versions()).toEqual([catalogVersion()])
    markCatalogChanged("visible")
    vi.advanceTimersByTime(VISIBLE_GAP_MS)
    expect(res.versions()).toEqual([])

    seesNothing = false
    markCatalogChanged("visible")
    vi.advanceTimersByTime(VISIBLE_GAP_MS)
    expect(res.versions()).toEqual([catalogVersion()])
    markCatalogChanged("visible")
    vi.advanceTimersByTime(VISIBLE_GAP_MS)
    expect(res.versions()).toEqual([catalogVersion()])
  })

  it("tells a caller given their first session the version at the next heartbeat", () => {
    let seesNothing = true
    const visibility = () => Object.assign(async () => "hidden" as const, { everything: false, nothing: seesNothing })
    installFakeEdition({ access: { ...PERSONAL_EDITION.access, visibilityFor: visibility } })
    const { res } = connect()
    res.versions()
    seesNothing = false
    vi.advanceTimersByTime(HEARTBEAT_MS)
    expect(res.versions()).toEqual([catalogVersion()])
  })

  it("names this server run in every frame", () => {
    const { res } = connect()
    expect(res.chunks[0]).toBe(`event: version\ndata: {"version":${catalogVersion()},"epoch":"${LIST_EPOCH}"}\n\n`)
  })

  it("starts nothing for a caller gone before the stream opens", () => {
    const res = Object.assign(new StreamResponse(), { destroyed: true })
    handleSessionListEvents(asIncomingMessage({ method: "GET", url: "/", headers: {} }), asServerResponse(res), vi.fn())
    expect(res.head).toBeNull()
    expect(inputs.follow).not.toHaveBeenCalled()
    expect(hasCatalogListeners()).toBe(false)
  })
})
