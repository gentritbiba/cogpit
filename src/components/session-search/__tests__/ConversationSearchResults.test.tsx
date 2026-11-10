import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ConversationSearchResults } from "../ConversationSearchResults"
import type { SessionSearchHit, SessionSearchResponse } from "../types"

const hit: SessionSearchHit = { chunkId: 1, kind: "user", snippet: "Remember the release decision", timestamp: "2026-11-10T10:00:00Z", match: "keyword", score: 1, automated: false, agentId: null, openTurnId: "t2", openTurn: 2 }
const response: SessionSearchResponse = { query: "release", semantic: { state: "ready" }, indexing: { pendingFiles: 0, pendingEmbeddings: 0 }, results: [{ sessionId: "s1", dirName: "-work-app", fileName: "s1.jsonl", title: "Release planning", cwd: "/work/app", agentKind: "", archived: false, hits: [hit] }] }
function setup(data: SessionSearchResponse | null = response) {
  const onSelectSession = vi.fn()
  const onOpenQuoteSource = vi.fn(async () => true)
  return { ...render(<ConversationSearchResults response={data} onSelectSession={onSelectSession} onOpenQuoteSource={onOpenQuoteSource} />), onSelectSession, onOpenQuoteSource }
}
function withHits(hits: SessionSearchHit[], extras = {}) {
  return { ...response, results: [{ ...response.results[0], ...extras, hits }] }
}

describe("ConversationSearchResults", () => {
  it("renders session metadata and opens a hit through quote navigation", () => {
    const { onOpenQuoteSource, onSelectSession } = setup()
    expect(screen.getByRole("heading", { name: "In conversations" })).toBeInTheDocument()
    expect(screen.getByText("Release planning")).toBeInTheDocument()
    expect(screen.getByText("app")).toBeInTheDocument()
    expect(screen.getByText("You")).toBeInTheDocument()
    expect(screen.getByText("Keyword")).toBeInTheDocument()
    expect(document.querySelector("time")).toHaveAttribute("dateTime", hit.timestamp)
    fireEvent.click(screen.getByRole("button", { name: /Remember the release/ }))
    expect(onOpenQuoteSource).toHaveBeenCalledWith({ dirName: "-work-app", fileName: "s1.jsonl", sessionId: "s1", turnId: "t2" }, "", 2)
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  it("passes an ordinal without a turn id and opens just the session when both are unknown", () => {
    const { rerender, onSelectSession, onOpenQuoteSource } = setup(withHits([{ ...hit, openTurnId: null, openTurn: 0 }]))
    fireEvent.click(screen.getByRole("button", { name: /Remember/ }))
    expect(onOpenQuoteSource).toHaveBeenCalledWith(expect.objectContaining({ turnId: "" }), "", 0)
    rerender(<ConversationSearchResults response={withHits([{ ...hit, openTurnId: null, openTurn: null }])} onSelectSession={onSelectSession} onOpenQuoteSource={onOpenQuoteSource} />)
    fireEvent.click(screen.getByRole("button", { name: /Remember/ }))
    expect(onSelectSession).toHaveBeenCalledWith("-work-app", "s1.jsonl")
  })

  it("shows up to three snippets, semantic markers and quieter automated messages", () => {
    setup(withHits([hit, { ...hit, chunkId: 2, kind: "thinking", snippet: "Second", match: "semantic", automated: true }, { ...hit, chunkId: 3, kind: "assistant", snippet: "Third", match: "both" }, { ...hit, chunkId: 4, snippet: "Fourth" }], { title: null }))
    expect(screen.getByText("Untitled session")).toBeInTheDocument()
    expect(screen.getByText("By meaning")).toBeInTheDocument()
    expect(screen.getByText("Keyword + meaning")).toBeInTheDocument()
    expect(screen.getByText("Thinking · automated")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Second/ })).toHaveClass("text-muted-foreground")
    expect(screen.queryByText("Fourth")).not.toBeInTheDocument()
  })

  it("opens archived stored text in a read-only dialog", () => {
    const { onSelectSession, onOpenQuoteSource } = setup(withHits([{ ...hit, text: "Full archived text <script>plain text</script>" }], { archived: true, dirName: null, fileName: null }))
    fireEvent.click(screen.getByRole("button", { name: /Remember/ }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText("Full archived text <script>plain text</script>")).toBeInTheDocument()
    expect(onSelectSession).not.toHaveBeenCalled()
    expect(onOpenQuoteSource).not.toHaveBeenCalled()
  })

  it("hides missing and empty responses, but shows a quiet indexing line while files are pending", () => {
    const { rerender, onSelectSession } = setup(null)
    expect(screen.queryByText("In conversations")).not.toBeInTheDocument()
    rerender(<ConversationSearchResults response={{ ...response, results: [] }} onSelectSession={onSelectSession} />)
    expect(screen.queryByText("In conversations")).not.toBeInTheDocument()
    rerender(<ConversationSearchResults response={{ ...response, results: [], indexing: { pendingFiles: 1, pendingEmbeddings: 0 } }} onSelectSession={onSelectSession} />)
    expect(screen.getByRole("status")).toHaveTextContent("Indexing conversations…")
  })
})
