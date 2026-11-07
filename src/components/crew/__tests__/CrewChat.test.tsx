import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CrewChatPage } from "../../../../shared/contracts/crewChat"
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), json: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.fetch, jsonFetch: mocks.json }))
import { CrewChat } from "../CrewChat"
import { OpenAIIcon } from "@/lib/agents/brandIcons"

const initial: CrewChatPage = {
  rootId: "lead", canPost: true, nextCursor: 1, hasMore: false,
  members: [{ sessionId: "lead", name: "Lead", handle: "lead", listening: true, canInteract: true }, { sessionId: "parser", name: "Parser", handle: "parser", listening: false, canInteract: true }],
  messages: [{ sequence: 1, id: "message-001", rootId: "lead", author: { kind: "agent", name: "Parser", sessionId: "parser" }, text: "Found the issue", mentions: ["lead"], createdAt: Date.now() }],
}
const response = (body: unknown, ok = true) => Response.json(body, { status: ok ? 200 : 403 })
beforeEach(() => {
  mocks.fetch.mockReset().mockResolvedValue(response(initial))
  mocks.json.mockReset().mockImplementation(async (_url, body, options) => response(options?.method === "PATCH" ? { listening: body.listening } : { message: { ...initial.messages[0], sequence: 2, id: body.commandId, author: { kind: "user", name: "You" }, text: body.text, mentions: [] }, pending: [] }))
})
afterEach(cleanup)

describe("CrewChat", () => {
  it("shows shared messages, who they are for and per-member listening controls", async () => {
    render(<CrewChat rootId="lead" />)
    expect(await screen.findByText("Found the issue")).toBeInTheDocument()
    expect(screen.getByRole("article", { name: "Message from Parser" })).toHaveTextContent("ParserToLead")
    fireEvent.click(screen.getByText("1 listening · Members & mentions"))
    expect(await screen.findByRole("switch", { name: "Listen for Lead" })).toBeChecked()
    expect(screen.getByRole("switch", { name: "Listen for Parser" })).not.toBeChecked()
    fireEvent.click(screen.getByRole("switch", { name: "Listen for Parser" }))
    await waitFor(() => expect(mocks.json).toHaveBeenCalledWith("/api/crew-chat/lead", { sessionId: "parser", listening: true }, { method: "PATCH" }))
    await waitFor(() => expect(screen.getByRole("switch", { name: "Listen for Parser" })).toBeChecked())
  })
  it("inserts an agent handle and sends as the user without forging an agent sender", async () => {
    render(<CrewChat rootId="lead" />)
    await screen.findByText("Found the issue")
    fireEvent.click(screen.getByText("1 listening · Members & mentions"))
    fireEvent.click(await screen.findByRole("button", { name: "Mention Parser" }))
    expect(screen.getByRole("textbox", { name: "Message the crew" })).toHaveValue("@parser ")
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@parser Check this finding" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect(await screen.findByRole("article", { name: "Message from You" })).toHaveTextContent("@parser Check this finding")
    expect(mocks.json).toHaveBeenCalledWith("/api/crew-chat/lead", { text: "@parser Check this finding", commandId: expect.any(String) })
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""))
  })
  it("preserves the draft and command ID across a failed send and retry", async () => {
    render(<CrewChat rootId="lead" />)
    await screen.findByText("Found the issue")
    mocks.json.mockRejectedValueOnce(new Error("Connection lost"))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Finding to share" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true })
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost")
    expect(screen.getByRole("textbox")).toHaveValue("Finding to share")
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await screen.findByText("Finding to share")
    expect(mocks.json.mock.calls[0]![1].commandId).toBe(mocks.json.mock.calls[1]![1].commandId)
  })
  it("renders a message as markdown with the opening mention moved to its header", async () => {
    mocks.fetch.mockResolvedValue(response({ ...initial, messages: [{ ...initial.messages[0], text: "@lead **Done**: (a) tests PASS (b) ask @parser" }] }))
    render(<CrewChat rootId="lead" />)
    const message = await screen.findByRole("article", { name: "Message from Parser" })
    expect(message.querySelector("strong")).toHaveTextContent("Done")
    expect([...message.querySelectorAll("ol > li")].map((item) => item.textContent)).toEqual(["tests PASS", "ask @parser"])
    expect(message).toHaveTextContent("ParserToLead")
    expect(message).not.toHaveTextContent("@lead")
  })
  it("marks an agent's messages with its provider's icon", async () => {
    render(<CrewChat rootId="lead" kinds={new Map([["parser", "codex"]])} />)
    const message = await screen.findByRole("article", { name: "Message from Parser" })
    const mark = render(<OpenAIIcon />).container.querySelector("path")!.getAttribute("d")
    expect(message.querySelector("span[aria-hidden] path")).toHaveAttribute("d", mark)
  })
  it("loads earlier history without duplicating existing messages", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ ...initial, hasMore: true, messages: [{ ...initial.messages[0], sequence: 2 }] }))
    render(<CrewChat rootId="lead" />)
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }))
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith("/api/crew-chat/lead?before=2"))
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2))
  })
  it("keeps read-only crew access read-only", async () => {
    mocks.fetch.mockResolvedValue(response({ ...initial, canPost: false, members: initial.members.map((member) => ({ ...member, canInteract: false })) }))
    render(<CrewChat rootId="lead" />)
    await screen.findByText("Found the issue")
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    fireEvent.click(screen.getByText("1 listening · Members & mentions"))
    expect(await screen.findByRole("switch", { name: "Listen for Lead" })).toHaveAttribute("aria-disabled", "true")
  })
})
