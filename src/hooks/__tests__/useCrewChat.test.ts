import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrewChatMember, CrewChatMessage, CrewChatPage } from "../../../shared/contracts/crewChat"

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), json: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch, jsonFetch: mocks.json }))

import { nextChatPage, useCrewChat } from "../useCrewChat"
import { useCrewChatMembers } from "../useCrewChatMembers"

const members: CrewChatMember[] = [{ sessionId: "lead", name: "Lead", handle: "lead", listening: true, canInteract: true }]
const message = (sequence: number): CrewChatMessage => ({
  sequence, id: `m${sequence}`, rootId: "lead", author: { kind: "user", name: "You" }, text: `hello ${sequence}`, mentions: [], createdAt: 1,
})
const page = (patch: Partial<CrewChatPage> & { membersVersion?: string } = {}) => ({
  rootId: "lead", messages: [message(1)], members, nextCursor: 1, hasMore: false, canPost: true, ...patch,
})
const urls = () => mocks.fetch.mock.calls.map(([url]) => url as string)

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.fetch.mockReset()
  mocks.json.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe("useCrewChat", () => {
  it("reads nothing while the chat is hidden and catches up when it is shown", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(page({ membersVersion: "m1" }), { headers: { ETag: '"p1"' } }))
    mocks.fetch.mockResolvedValue(Response.json(page({ messages: [message(2)], nextCursor: 2, members: undefined })))
    const { result, rerender } = renderHook(({ active }) => useCrewChat("lead", active), { initialProps: { active: true } })
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    const shown = result.current.page!.members

    rerender({ active: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.fetch).toHaveBeenCalledOnce()

    rerender({ active: true })
    await waitFor(() => expect(result.current.messages.map((value) => value.sequence)).toEqual([1, 2]))
    expect(urls()[1]).toBe("/api/crew-chat/lead?after=1&limit=100&knownMembers=m1")
    expect(new Headers(mocks.fetch.mock.calls[1]![1].headers).get("If-None-Match")).toBe('"p1"')
    expect(result.current.page?.members).toBe(shown)
  })

  it("keeps the page and messages as they are on 304", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(page(), { headers: { ETag: '"p1"' } }))
    mocks.fetch.mockResolvedValue(new Response(null, { status: 304 }))
    const { result } = renderHook(() => useCrewChat("lead"))
    await waitFor(() => expect(result.current.page).not.toBeNull())
    const before = { page: result.current.page, messages: result.current.messages }
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(result.current.page).toBe(before.page)
    expect(result.current.messages).toBe(before.messages)
    expect(result.current.error).toBeNull()
  })

  it("never names known members to a server that sent no version", async () => {
    mocks.fetch.mockResolvedValue(Response.json(page()))
    const { result } = renderHook(() => useCrewChat("lead"))
    await waitFor(() => expect(result.current.page).not.toBeNull())
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(urls()[1]).toBe("/api/crew-chat/lead?after=1&limit=100")
  })

  it("reads members in full after changing who listens", async () => {
    mocks.fetch.mockResolvedValue(Response.json(page({ membersVersion: "m1" }), { headers: { ETag: '"p1"' } }))
    mocks.json.mockResolvedValue(Response.json({ listening: false }))
    const { result } = renderHook(() => useCrewChat("lead"))
    await waitFor(() => expect(result.current.page).not.toBeNull())
    await act(() => result.current.setListening("lead", false))
    expect(result.current.page?.members[0]!.listening).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(urls().at(-1)).toBe("/api/crew-chat/lead?after=1&limit=100")
    expect(new Headers(mocks.fetch.mock.calls.at(-1)![1].headers).has("If-None-Match")).toBe(false)
  })
})

describe("nextChatPage", () => {
  it("keeps the current page when nothing it shows changed", () => {
    const current = nextChatPage(null, page({ membersVersion: "m1" }))
    expect(nextChatPage(current, page({ messages: [message(2)], members: undefined, membersVersion: "m1" }))).toBe(current)
    expect(nextChatPage(current, page({ members: members.map((member) => ({ ...member })), membersVersion: "m1" }))).toBe(current)
  })

  it("compares members by value from a server without versions", () => {
    const current = nextChatPage(null, page())
    expect(nextChatPage(current, page({ members: members.map((member) => ({ ...member })) }))).toBe(current)
    const changed = nextChatPage(current, page({ members: [{ ...members[0]!, listening: false }] }))
    expect(changed.members[0]!.listening).toBe(false)
  })

  it("takes new members when their version moved", () => {
    const current = nextChatPage(null, page({ membersVersion: "m1" }))
    const grown = [...members, { sessionId: "lane", name: "Lane", handle: "lane", listening: false, canInteract: true }]
    const next = nextChatPage(current, page({ members: grown, membersVersion: "m2" }))
    expect(next.members).toBe(grown)
    expect(next.membersVersion).toBe("m2")
  })
})

describe("useCrewChatMembers", () => {
  it("reads members without claiming to know them", async () => {
    mocks.fetch.mockResolvedValue(Response.json(page({ membersVersion: "m1" })))
    const { result } = renderHook(() => useCrewChatMembers("root-members"))
    await waitFor(() => expect(result.current).toEqual(members))
    expect(urls()).toEqual(["/api/crew-chat/root-members?limit=1"])
  })
})
