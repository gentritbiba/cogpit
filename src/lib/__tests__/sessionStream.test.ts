import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, authUrl: (url: string) => `/hub/dev${url}` }))

import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { SESSION_ACCESS_CHANGED_EVENT, SESSION_ACCESS_LOST_EVENT } from "@/lib/sessionAccessEvents"
import { onSessionConfigChanged } from "@/lib/sessionConfigEvents"
import { openSessionStream } from "@/lib/sessionStream"
import { NO_CAPABILITIES } from "../../../shared/contracts/identity"
import { SESSION_ACCESS_HEADER } from "../../../shared/contracts/sessionAccess"

const SESSION = "00000000-0000-4000-8000-000000000001"
const URL_PATH = `/api/watch/-work/${SESSION}.jsonl`
const TEAM_URL = "/api/team-watch/alpha"

class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2
  static last: FakeEventSource
  readonly url: string
  readyState = 1
  closed = false

  constructor(url: string) {
    super()
    this.url = url
    FakeEventSource.last = this
  }

  close(): void {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  giveUp(): void {
    this.readyState = FakeEventSource.CLOSED
    this.dispatchEvent(new Event("error"))
  }
}

function heard(): Array<{ type: string; sessionId: unknown }> {
  const events: Array<{ type: string; sessionId: unknown }> = []
  for (const type of [SESSION_ACCESS_LOST_EVENT, SESSION_ACCESS_CHANGED_EVENT]) {
    window.addEventListener(type, (event) => {
      events.push({ type, sessionId: (event as CustomEvent<{ sessionId?: unknown }>).detail.sessionId })
    }, { signal: listening.signal })
  }
  return events
}

let listening: AbortController

function signInTeamMember(): void {
  setMe({
    authenticated: true,
    edition: "team",
    user: { id: "u_bob", username: "bob", displayName: "Bob" },
    capabilities: NO_CAPABILITIES,
    enforcesSessionAccess: true,
  })
}

describe("openSessionStream", () => {
  beforeEach(() => {
    listening = new AbortController()
    mocks.authFetch.mockReset()
    vi.stubGlobal("EventSource", FakeEventSource)
  })

  afterEach(() => {
    listening.abort()
    vi.unstubAllGlobals()
    __resetCapabilitiesForTest()
  })

  it("opens the stream on the active device and passes on its access frames", () => {
    const events = heard()
    const stream = openSessionStream(URL_PATH)
    expect(stream.source.url).toBe(`/hub/dev${URL_PATH}`)

    const frame = (level: string) => new MessageEvent("access", { data: JSON.stringify({ sessionId: SESSION, level }) })
    stream.source.dispatchEvent(frame("interact"))
    stream.source.dispatchEvent(frame("none"))
    stream.source.dispatchEvent(new MessageEvent("access", { data: "not json" }))

    expect(events).toEqual([
      { type: SESSION_ACCESS_CHANGED_EVENT, sessionId: SESSION },
      { type: SESSION_ACCESS_LOST_EVENT, sessionId: SESSION },
    ])
  })

  it("passes on the frames that say the session's config changed, until closed", () => {
    const changed = vi.fn()
    const other = vi.fn()
    const stopChanged = onSessionConfigChanged(SESSION, changed)
    const stopOther = onSessionConfigChanged("00000000-0000-4000-8000-000000000002", other)
    const stream = openSessionStream(URL_PATH)

    stream.source.dispatchEvent(new MessageEvent("session-config", { data: JSON.stringify({ sessionId: SESSION }) }))
    stream.source.dispatchEvent(new MessageEvent("session-config", { data: SESSION }))
    stream.source.dispatchEvent(new MessageEvent("session-config", { data: JSON.stringify({ level: "view" }) }))
    stream.close()
    stream.source.dispatchEvent(new MessageEvent("session-config", { data: SESSION }))
    stopChanged()
    stopOther()

    expect(changed).toHaveBeenCalledTimes(2)
    expect(other).not.toHaveBeenCalled()
  })

  it("asks once more why a team stream gave up, and lets go of the answer", async () => {
    signInTeamMember()
    const cancel = vi.fn()
    mocks.authFetch.mockResolvedValue({ headers: new Headers(), body: { cancel } })
    openSessionStream(URL_PATH)

    FakeEventSource.last.readyState = 0
    FakeEventSource.last.dispatchEvent(new Event("error"))
    expect(mocks.authFetch).not.toHaveBeenCalled()

    FakeEventSource.last.giveUp()
    expect(mocks.authFetch).toHaveBeenCalledWith(URL_PATH, { signal: expect.any(AbortSignal) })
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it("tells its watcher the stream is lost when the answer refuses what it watches, named or not", async () => {
    signInTeamMember()
    const refusedSight = new Response("{}", { status: 404, headers: { [SESSION_ACCESS_HEADER]: "none" } })
    let answerLate!: (res: Response) => void
    mocks.authFetch
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { answerLate = resolve }))
      .mockResolvedValueOnce(refusedSight)
    const unavailable = vi.fn()
    const closedFirst = vi.fn()
    const lost = vi.fn()

    openSessionStream(TEAM_URL, { onLost: unavailable })
    FakeEventSource.last.giveUp()
    const closed = openSessionStream(TEAM_URL, { onLost: closedFirst })
    FakeEventSource.last.giveUp()
    closed.close()
    answerLate(refusedSight.clone())
    openSessionStream(TEAM_URL, { onLost: lost })
    FakeEventSource.last.giveUp()

    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce())
    expect(unavailable).not.toHaveBeenCalled()
    expect(closedFirst).not.toHaveBeenCalled()
  })

  it("asks nothing of a personal server, and stops asking once closed", () => {
    openSessionStream(URL_PATH)
    FakeEventSource.last.giveUp()
    expect(mocks.authFetch).not.toHaveBeenCalled()

    signInTeamMember()
    mocks.authFetch.mockReturnValue(new Promise(() => undefined))
    const stream = openSessionStream(URL_PATH)
    FakeEventSource.last.giveUp()
    const { signal } = mocks.authFetch.mock.calls[0][1] as { signal: AbortSignal }
    stream.close()
    expect(signal.aborted).toBe(true)
    expect(FakeEventSource.last.closed).toBe(true)
  })
})
