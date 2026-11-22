// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { TelemetryDelivery } from "../../telemetry/delivery"

function reply(status: number): Response {
  return new Response(status === 200 ? "{}" : "no", { status })
}

function setup(statuses: Array<number | Error>, options: { maxQueued?: number; batchSize?: number } = {}) {
  let now = 1_000_000
  const fetch = vi.fn(async () => {
    const next = statuses.shift() ?? 200
    if (next instanceof Error) throw next
    return reply(next)
  })
  const delivery = new TelemetryDelivery({
    endpoint: "https://telemetry.test/v1/batch",
    installId: "a".repeat(32),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => now,
    random: () => 0,
    ...options,
  })
  return { delivery, fetch, advance: (ms: number) => { now += ms } }
}

function sentBatch(fetch: ReturnType<typeof vi.fn>, call = 0): { installId: string; batch: Array<{ event: string; uuid: string }> } {
  const init = (fetch.mock.calls[call] as unknown[])[1] as { body: string }
  return JSON.parse(init.body)
}

describe("TelemetryDelivery", () => {
  it("sends queued events in batches with the install id", async () => {
    const { delivery, fetch } = setup([], { batchSize: 2 })
    delivery.enqueue("a", {})
    delivery.enqueue("b", {})
    delivery.enqueue("c", {})
    await delivery.flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sentBatch(fetch).installId).toBe("a".repeat(32))
    expect(sentBatch(fetch).batch.map((event) => event.event)).toEqual(["a", "b"])
    expect(sentBatch(fetch, 1).batch.map((event) => event.event)).toEqual(["c"])
    expect(delivery.pending).toBe(0)
  })

  it("keeps a failed batch, waits out the backoff, then sends the same events again", async () => {
    const { delivery, fetch, advance } = setup([503, 200])
    delivery.enqueue("a", {})
    await delivery.flush()
    expect(delivery.pending).toBe(1)

    await delivery.flushWhenDue()
    expect(fetch).toHaveBeenCalledTimes(1)

    advance(1_000)
    await delivery.flushWhenDue()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sentBatch(fetch, 1).batch[0].uuid).toBe(sentBatch(fetch).batch[0].uuid)
    expect(delivery.pending).toBe(0)
  })

  it("drops a batch the endpoint rejects", async () => {
    const { delivery, fetch } = setup([400])
    delivery.enqueue("a", {})
    await delivery.flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(delivery.pending).toBe(0)
  })

  it("drops a batch that kept failing for half an hour", async () => {
    const { delivery, advance } = setup([new Error("offline"), new Error("offline"), new Error("offline")])
    delivery.enqueue("a", {})
    await delivery.flush()
    advance(10 * 60_000)
    await delivery.flush()
    expect(delivery.pending).toBe(1)
    advance(25 * 60_000)
    await delivery.flush()
    expect(delivery.pending).toBe(0)
  })

  it("keeps only the newest events when the queue is full", async () => {
    const { delivery, fetch } = setup([], { maxQueued: 2 })
    delivery.enqueue("a", {})
    delivery.enqueue("b", {})
    delivery.enqueue("c", {})
    await delivery.flush()
    expect(sentBatch(fetch).batch.map((event) => event.event)).toEqual(["b", "c"])
  })

  it("forgets everything on clear", async () => {
    const { delivery, fetch } = setup([])
    delivery.enqueue("a", {})
    delivery.clear()
    await delivery.flush()
    expect(fetch).not.toHaveBeenCalled()
  })
})
