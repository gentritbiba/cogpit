import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch }))
vi.mock("@/hooks/useIsDarkMode", () => ({ useIsDarkMode: () => true }))
vi.mock("@/lib/shiki", () => ({ getLangFromPath: () => null, highlightCode: vi.fn() }))

import { ToolResultPanel } from "../ToolCallResult"
import { ElidedResultImage } from "../ElidedResultImage"
import { __resetToolResultBodiesForTest, BODY_CACHE_CHARS, cachedBodyChars, fetchBodyChunk, fetchFullBody } from "@/lib/toolResultBodies"
import type { ElidedResult } from "../../../../shared/session/types"

const stub = (ref = "r1.body.mac", bytes = 120_000): ElidedResult => ({ ref, bytes, lines: 4000, kind: "text", source: { dirName: "proj a", fileName: "s.jsonl" } })
const ok = (text: string, total = text.length, start = 0) => new Response(JSON.stringify({ kind: "text", text, start, end: start + text.length, total }), { status: 200 })

beforeEach(() => { authFetch.mockReset(); __resetToolResultBodiesForTest() })
afterEach(() => vi.useRealTimers())

describe("an elided tool result", () => {
  it("shows its preview and fetches nothing until it is expanded", async () => {
    authFetch.mockResolvedValue(ok("FULL BODY"))
    render(<ToolResultPanel result={"preview head\n…\npreview tail"} resultRef={stub()} />)
    expect(screen.getByText(/preview head/)).toBeInTheDocument()
    expect(authFetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /Show full output \(4,000 lines, 117 KB\)/ }))
    await waitFor(() => expect(screen.getByText("FULL BODY")).toBeInTheDocument())
    expect(authFetch).toHaveBeenCalledWith("/api/tool-result/proj%20a/s.jsonl?ref=r1.body.mac&start=0", expect.objectContaining({ signal: expect.any(AbortSignal) }))

    // Collapsing and expanding again reads the cache.
    fireEvent.click(screen.getByRole("button", { name: "Show less" }))
    fireEvent.click(screen.getByRole("button", { name: /Show full output/ }))
    await waitFor(() => expect(screen.getByText("FULL BODY")).toBeInTheDocument())
    expect(authFetch).toHaveBeenCalledTimes(1)
  })

  it("aborts the fetch when collapsed before it answers", async () => {
    let signal: AbortSignal | undefined
    authFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => { signal = init.signal; return new Promise(() => {}) })
    render(<ToolResultPanel result="preview" resultRef={stub()} />)
    fireEvent.click(screen.getByRole("button", { name: /Show full output/ }))
    expect(await screen.findByRole("status")).toHaveTextContent(/Loading full output/)
    fireEvent.click(screen.getByRole("button", { name: "Show less" }))
    expect(signal?.aborted).toBe(true)
  })

  it("keeps the preview and explains why when the body changed or access was lost", async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({ state: "stale" }), { status: 410 }))
    const { unmount } = render(<ToolResultPanel result="saved preview" resultRef={stub("r1.a.b")} />)
    fireEvent.click(screen.getByRole("button", { name: /Show full output/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed or was removed/)
    expect(screen.getByText("saved preview")).toBeInTheDocument()
    unmount()
    authFetch.mockResolvedValueOnce(new Response("{}", { status: 404 }))
    render(<ToolResultPanel result="saved preview" resultRef={stub("r1.c.d")} />)
    fireEvent.click(screen.getByRole("button", { name: /Show full output/ }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer have access/)
  })

  it("loads a body larger than one response chunk by chunk", async () => {
    authFetch.mockResolvedValueOnce(ok("first-", 12)).mockResolvedValueOnce(ok("second", 12, 6))
    render(<ToolResultPanel result="preview" resultRef={stub()} />)
    fireEvent.click(screen.getByRole("button", { name: /Show full output/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }))
    await waitFor(() => expect(screen.getByText("first-second")).toBeInTheDocument())
    expect(authFetch).toHaveBeenLastCalledWith(expect.stringContaining("&start=6"), expect.anything())
  })

  it("loads a kept-back image only when asked", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({ kind: "image", text: "aGk=", start: 0, end: 4, total: 4 }), { status: 200 }))
    render(<ElidedResultImage stub={{ ...stub(), kind: "image", bytes: 4 }} mediaType="image/png" alt="Tool result image 1" id="img" />)
    expect(authFetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Load image" }))
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load image" })).not.toBeInTheDocument())
  })
})

describe("the body cache", () => {
  it("stays within its character budget, dropping the oldest bodies", async () => {
    const big = "x".repeat(BODY_CACHE_CHARS / 2 + 1)
    authFetch.mockImplementation(async () => ok(big))
    await fetchBodyChunk(stub("r1.one.x"), 0)
    await fetchBodyChunk(stub("r1.two.x"), 0)
    expect(cachedBodyChars()).toBeLessThanOrEqual(BODY_CACHE_CHARS)
    await fetchBodyChunk(stub("r1.two.x"), 0)
    expect(authFetch).toHaveBeenCalledTimes(2)
    await fetchBodyChunk(stub("r1.one.x"), 0)
    expect(authFetch).toHaveBeenCalledTimes(3)
  })
})

describe("copying an elided result", () => {
  it("copies a body longer than the cache budget whole, without letting the cache grow past it", async () => {
    const total = BODY_CACHE_CHARS + 1_048_576
    authFetch.mockImplementation(async (url: string) => {
      const start = Number(new URL(url, "http://x").searchParams.get("start"))
      const text = "z".repeat(Math.min(1_048_576, total - start))
      return ok(text, total, start)
    })
    const full = await fetchFullBody(stub())
    expect(full).toMatchObject({ complete: true, total })
    expect(full.text.length).toBe(total)
    expect(cachedBodyChars()).toBe(0)
  })

  it("says when a copy holds only the start, or only the preview", async () => {
    authFetch.mockImplementation(async (url: string) => {
      const start = Number(new URL(url, "http://x").searchParams.get("start"))
      return ok("a".repeat(1_000), 3_000, start)
    })
    await expect(fetchFullBody(stub(), 2_000)).resolves.toMatchObject({ complete: false, total: 3_000, text: "a".repeat(2_000) })

    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
    authFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ state: "stale" }), { status: 410 }))
    render(<ToolResultPanel result="saved preview" resultRef={stub("r1.copy.x")} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy result" }))
    expect(await screen.findByText(/Copied the saved preview only/)).toBeInTheDocument()
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("saved preview"))
  })
})
