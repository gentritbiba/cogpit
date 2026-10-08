import { describe, expect, it, vi } from "vitest"
import type { CommandReceipt } from "../../../shared/contracts/orchestration"

vi.mock("../auth", () => ({ authFetch: vi.fn(() => new Promise(() => {})), authUrl: (url: string) => url }))
import { admitReceipt, conversationStateFor } from "../conversationState"

const receipt: CommandReceipt = { id: "command", conversationId: "conversation", sessionId: "s1", bindingRevision: 1, state: "queued", intent: "queue", message: "hello", createdAt: 1, updatedAt: 1, position: 1 }

describe("admitReceipt", () => {
  it("shows an accepted command only in a queue someone is watching, once", () => {
    expect(admitReceipt(receipt)).toBe(false)

    const owner = conversationStateFor("s1")
    const stop = owner.subscribe(() => {})
    expect(admitReceipt(receipt)).toBe(true)
    expect(admitReceipt(receipt)).toBe(true)
    expect(owner.snapshot().commands).toEqual([receipt])

    stop()
    expect(admitReceipt(receipt)).toBe(false)
  })
})
