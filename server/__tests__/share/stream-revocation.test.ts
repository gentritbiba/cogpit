// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  authMiddleware,
  createShareToken,
  revokeShareToken,
  revokeShareTokensForSession,
  revokeAllShareTokens,
  __resetShareTokensForTest,
  SESSION_IDLE_TTL_MS,
} from "../../security"
import { getConfig } from "../../config"
import { initShareRegistry, createShare, removeShare } from "../../share/registry"
import { __resetEditionForTest } from "../../team/edition"

vi.mock("../../config", () => ({ getConfig: vi.fn() }))

const mockedGetConfig = vi.mocked(getConfig)

const UA = "Guest/1"
const GUEST_IP = "203.0.113.5"
const HOST = "cogpit.example"

const SHARES = [
  { sessionId: "sess-1", dirName: "-Users-me-proj", fileName: "sess-1.jsonl" },
  { sessionId: "sess-2", dirName: "-Users-me-proj", fileName: "sess-2.jsonl" },
  // Removed by the "host stops sharing" test, so it must not be one of the
  // shares the other cases depend on.
  { sessionId: "sess-3", dirName: "-Users-me-proj", fileName: "sess-3.jsonl" },
] as const

const REVOCABLE = SHARES[2]

let registryRoot: string

interface GuestStream {
  token: string
  destroy: ReturnType<typeof vi.fn>
  /** Fire the lifecycle event the Node response would emit. */
  emit: (event: "finish" | "close") => void
  end: () => void
}

function openGuestStream(share: (typeof SHARES)[number], url?: string): GuestStream {
  const token = createShareToken(share.sessionId, GUEST_IP, UA)
  const listeners = new Map<string, () => void>()
  const destroy = vi.fn()
  let writableEnded = false
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
    destroy,
    get writableEnded() { return writableEnded },
    once: (event: string, listener: () => void) => { listeners.set(event, listener) },
  } as unknown as ServerResponse
  const req = {
    socket: { remoteAddress: GUEST_IP },
    url: url ?? `/api/watch/${share.dirName}/${share.fileName}`,
    method: "GET",
    headers: { host: HOST, cookie: `__Host-cogpit_share=${token}`, "user-agent": UA },
  } as unknown as IncomingMessage

  const next = vi.fn()
  authMiddleware(req, res, next)
  if (next.mock.calls.length !== 1) {
    throw new Error(`Guest stream was not admitted (status ${res.statusCode})`)
  }

  return {
    token,
    destroy,
    emit: (event) => listeners.get(event)?.(),
    end: () => { writableEnded = true },
  }
}

beforeAll(async () => {
  registryRoot = await mkdtemp(join(tmpdir(), "cogpit-share-stream-"))
  await initShareRegistry(registryRoot)
  for (const share of SHARES) await createShare(share)
})

afterAll(async () => {
  await rm(registryRoot, { recursive: true, force: true })
})

beforeEach(() => {
  mockedGetConfig.mockReturnValue({ networkAccess: true, networkPassword: "hashed" } as never)
  __resetShareTokensForTest()
})

afterEach(() => {
  vi.useRealTimers()
  __resetEditionForTest()
})

describe("share stream revocation", () => {
  it("destroys a guest SSE response when its session's share is revoked", () => {
    const stream = openGuestStream(SHARES[0])
    revokeShareTokensForSession(SHARES[0].sessionId)
    expect(stream.destroy).toHaveBeenCalled()
  })

  it("leaves another session's guest stream alone", () => {
    const revoked = openGuestStream(SHARES[0])
    const survivor = openGuestStream(SHARES[1])
    revokeShareTokensForSession(SHARES[0].sessionId)
    expect(revoked.destroy).toHaveBeenCalled()
    expect(survivor.destroy).not.toHaveBeenCalled()
  })

  it("destroys the stream when only that guest's token is revoked", () => {
    const stream = openGuestStream(SHARES[0])
    revokeShareToken(stream.token)
    expect(stream.destroy).toHaveBeenCalled()
  })

  it("destroys every guest stream on a global share revocation", () => {
    const first = openGuestStream(SHARES[0])
    const second = openGuestStream(SHARES[1])
    revokeAllShareTokens()
    expect(first.destroy).toHaveBeenCalled()
    expect(second.destroy).toHaveBeenCalled()
  })

  it("does not destroy a response that already finished writing", () => {
    const stream = openGuestStream(SHARES[0])
    stream.end()
    revokeShareTokensForSession(SHARES[0].sessionId)
    expect(stream.destroy).not.toHaveBeenCalled()
  })

  it("does not track ordinary guest requests", () => {
    vi.useFakeTimers()
    const before = vi.getTimerCount()
    const stream = openGuestStream(SHARES[0], `/api/session-status/${SHARES[0].sessionId}`)
    expect(vi.getTimerCount()).toBe(before)
    revokeShareTokensForSession(SHARES[0].sessionId)
    expect(stream.destroy).not.toHaveBeenCalled()
  })

  for (const event of ["finish", "close"] as const) {
    it(`stops rechecking once the response emits ${event}`, () => {
      vi.useFakeTimers()
      const before = vi.getTimerCount()
      const stream = openGuestStream(SHARES[0])
      expect(vi.getTimerCount()).toBe(before + 1)

      stream.emit(event)
      expect(vi.getTimerCount()).toBe(before)

      revokeShareTokensForSession(SHARES[0].sessionId)
      expect(stream.destroy).not.toHaveBeenCalled()
    })
  }

  it("destroys a stream whose token vanished without a revocation notice", () => {
    vi.useFakeTimers()
    const stream = openGuestStream(SHARES[0])
    // Simulates any silent disappearance (process-level reset, sweep); only the
    // periodic recheck can notice it.
    __resetShareTokensForTest()
    expect(stream.destroy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5_000)
    expect(stream.destroy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps a still-valid guest stream open across many recheck ticks", () => {
    vi.useFakeTimers()
    const stream = openGuestStream(SHARES[0])
    vi.advanceTimersByTime(15_000)
    expect(stream.destroy).not.toHaveBeenCalled()
  })

  it("destroys a guest stream once the host stops sharing the session", async () => {
    vi.useFakeTimers()
    const stream = openGuestStream(REVOCABLE)
    // No lifecycle hook fires here: the registry record simply stops existing,
    // which is all the recheck may rely on.
    await removeShare(REVOCABLE.sessionId)
    expect(stream.destroy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5_000)
    expect(stream.destroy).toHaveBeenCalled()

    await createShare(REVOCABLE)
  })

  it("cannot be kept alive past the idle window by its own rechecks", () => {
    vi.useFakeTimers()
    const stream = openGuestStream(SHARES[0])
    vi.advanceTimersByTime(SESSION_IDLE_TTL_MS + 5_000)
    expect(stream.destroy).toHaveBeenCalled()
  })
})
