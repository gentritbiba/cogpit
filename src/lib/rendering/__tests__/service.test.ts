// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { RenderWorkService, RENDER_LIMITS, type RenderWorker } from "../service"
import type { RenderOutput, RenderRequest, RenderResponse } from "../protocol"

class FakeWorker implements RenderWorker {
  onmessage: RenderWorker["onmessage"] = null
  onerror: RenderWorker["onerror"] = null
  onmessageerror: RenderWorker["onmessageerror"] = null
  posted: RenderRequest[] = []
  terminate = vi.fn()
  postMessage(message: RenderRequest) { this.posted.push(message) }
  reply(result: RenderOutput) { this.onmessage?.({ data: { id: this.posted.at(-1)!.id, result } } as MessageEvent<RenderResponse>) }
}
const tokens = [[{ content: "const", offset: 0, color: "#fff" }]]
const services: RenderWorkService[] = []
function setup() {
  const workers: FakeWorker[] = []
  const factory = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker })
  const service = new RenderWorkService(factory)
  services.push(service)
  return { service, workers, factory }
}
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers() })

describe("shared render work service", () => {
  it("acquires lazily, posts CPU work to a worker and shares identical jobs", async () => {
    const { service, workers, factory } = setup()
    expect(factory).not.toHaveBeenCalled()
    const first = service.highlight("const", "typescript", true)
    const second = service.highlight("const", "typescript", true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(workers[0].posted).toEqual([{ id: 1, input: { kind: "highlight", code: "const", lang: "typescript", isDark: true } }])
    workers[0].reply(tokens)
    expect(await first).toBe(tokens)
    expect(await second).toBe(tokens)
    expect(await service.highlight("const", "typescript", true)).toBe(tokens)
    expect(workers[0].posted).toHaveLength(1)
  })

  it("keys tokens by exact content, language and theme", async () => {
    const { service, workers } = setup()
    for (const [code, lang, dark] of [["a", "typescript", true], ["b", "typescript", true], ["a", "json", true], ["a", "typescript", false]] as const) {
      const result = service.highlight(code, lang, dark)
      workers[0].reply(tokens)
      await result
    }
    expect(workers[0].posted).toHaveLength(4)
  })

  it("cancels a subscriber without killing shared live work", async () => {
    const { service, workers } = setup()
    const controller = new AbortController()
    const first = service.highlight("x", "tsx", true, controller.signal).catch(error => error.name)
    const second = service.highlight("x", "tsx", true)
    controller.abort()
    expect(await first).toBe("AbortError")
    expect(workers[0].terminate).not.toHaveBeenCalled()
    workers[0].reply(tokens)
    expect(await second).toBe(tokens)
  })

  it("terminates obsolete synchronous work, removes queued stale work and fences late replies", async () => {
    const { service, workers } = setup()
    const active = new AbortController(), queued = new AbortController()
    const a = service.highlight("old", "tsx", true, active.signal).catch(error => error.name)
    const q = service.highlight("queued old", "tsx", true, queued.signal).catch(error => error.name)
    const latest = service.highlight("latest", "tsx", false)
    queued.abort()
    active.abort()
    expect(await a).toBe("AbortError")
    expect(await q).toBe("AbortError")
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[1].posted[0].input).toMatchObject({ code: "latest", isDark: false })
    workers[0].reply([[{ content: "stale", offset: 0 }]])
    expect(service.stats().cachedEntries).toBe(0)
    workers[1].reply(tokens)
    expect(await latest).toBe(tokens)
  })

  it.each(["onerror", "onmessageerror"] as const)("recovers %s with exact diff fallback and reacquires later", async event => {
    const { service, workers, factory } = setup()
    const diff = service.diff("a\nb", "a\nc")
    workers[0][event]?.(new Event("error") as ErrorEvent & MessageEvent)
    expect(await diff).toEqual([
      { type: "unchanged", text: "a", oldIdx: 0, newIdx: 0 },
      { type: "removed", text: "b", oldIdx: 1 },
      { type: "added", text: "c", newIdx: 1 },
    ])
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 1001)
    const highlighted = service.highlight("new", "tsx", true)
    expect(factory).toHaveBeenCalledTimes(2)
    workers[1].reply(tokens)
    await highlighted
  })

  it("recovers explicit async worker errors without waiting for a timeout", async () => {
    const { service, workers } = setup()
    const request = service.highlight("x", "tsx", true)
    workers[0].onmessage?.({ data: { id: 1, error: true } } as MessageEvent<RenderResponse>)
    expect(await request).toBeNull()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  })

  it("falls back to plain tokens and exact diffs when Worker is unavailable", async () => {
    const service = new RenderWorkService(() => { throw new Error("unavailable") })
    services.push(service)
    expect(await service.highlight("x", "tsx", true)).toBeNull()
    expect(await service.diff("", "\n")).toEqual([{ type: "added", text: "", newIdx: 0 }])
  })

  it("recovers a hung worker after the deadline", async () => {
    vi.useFakeTimers()
    const { service, workers } = setup()
    const request = service.highlight("x", "tsx", true)
    await vi.advanceTimersByTimeAsync(RENDER_LIMITS.timeoutMs)
    expect(await request).toBeNull()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
  })

  it("bounds FIFO entries and refuses excess jobs without posting them", async () => {
    const { service, workers } = setup()
    const requests = Array.from({ length: 40 }, (_, i) => service.highlight(String(i), "tsx", true).catch(() => null))
    expect(service.stats().queuedEntries).toBe(RENDER_LIMITS.queueEntries)
    expect(service.stats().queuedBytes).toBeLessThanOrEqual(RENDER_LIMITS.queueBytes)
    expect(await requests[39]).toBeNull()
    expect(workers[0].posted).toHaveLength(1)
    service.dispose()
    await Promise.all(requests)
  })

  it("bounds queued bytes independently of entries", async () => {
    const { service } = setup()
    const requests = Array.from({ length: 25 }, (_, i) => service.highlight("x".repeat(190_000) + i, "tsx", true).catch(() => null))
    expect(service.stats().queuedEntries).toBeLessThan(25)
    expect(service.stats().queuedBytes).toBeLessThanOrEqual(RENDER_LIMITS.queueBytes)
    service.dispose()
    await Promise.all(requests)
  })

  it("bounds cache entries with LRU access ordering", async () => {
    const { service, workers } = setup()
    for (let i = 0; i < 48; i++) { const p = service.highlight(String(i), "tsx", true); workers[0].reply(tokens); await p }
    await service.highlight("0", "tsx", true)
    const extra = service.highlight("extra", "tsx", true); workers[0].reply(tokens); await extra
    expect(service.stats().cachedEntries).toBe(48)
    await service.highlight("0", "tsx", true)
    expect(workers[0].posted).toHaveLength(49)
    const evicted = service.highlight("1", "tsx", true); workers[0].reply(tokens); await evicted
    expect(workers[0].posted).toHaveLength(50)
  })

  it("evicts by retained bytes even below the entry limit; never retains oversized results", async () => {
    const { service, workers } = setup()
    const hugeTokens = [[{ content: "x".repeat(1_000_000), offset: 0 }]]
    for (let i = 0; i < 10; i++) { const p = service.highlight(String(i), "tsx", true); workers[0].reply(hugeTokens); await p }
    expect(service.stats().cachedEntries).toBeLessThan(10)
    expect(service.stats().cacheBytes).toBeLessThanOrEqual(RENDER_LIMITS.cacheBytes)
    const before = service.stats().cachedEntries
    const p = service.highlight("enormous result", "tsx", true)
    workers[0].reply([[{ content: "y".repeat(RENDER_LIMITS.cacheBytes), offset: 0 }]])
    await p
    expect(service.stats().cachedEntries).toBe(before)
  })

  it("preserves oversized diffs through cooperative fallback without retaining them in queue/cache", async () => {
    const { service, factory } = setup()
    const source = "x".repeat(RENDER_LIMITS.jobBytes / 4 + 1)
    expect(await service.diff("", source)).toEqual([{ type: "added", text: source, newIdx: 0 }])
    expect(factory).not.toHaveBeenCalled()
    expect(service.stats()).toMatchObject({ cachedEntries: 0, cacheBytes: 0, queuedEntries: 0, queuedBytes: 0 })
  })

  it("skips oversized highlighting before acquiring a worker", async () => {
    const { service, factory } = setup()
    expect(await service.highlight("x".repeat(200_001), "tsx", true)).toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it("releases worker, grammar memory and cached sources after idle, then reacquires", async () => {
    vi.useFakeTimers()
    const { service, workers, factory } = setup()
    const p = service.highlight("x", "tsx", true); workers[0].reply(tokens); await p
    await vi.advanceTimersByTimeAsync(RENDER_LIMITS.idleMs)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(service.stats()).toMatchObject({ cachedEntries: 0, cacheBytes: 0, worker: false })
    const next = service.highlight("x", "tsx", true); workers[1].reply(tokens); await next
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it("rejects pre-cancelled work without acquisition", async () => {
    const { service, factory } = setup()
    const controller = new AbortController(); controller.abort()
    await expect(service.diff("a", "b", controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(factory).not.toHaveBeenCalled()
  })
})
