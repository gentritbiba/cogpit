import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const chat = vi.hoisted(() => ({ sendMessage: vi.fn(), present: true, canSend: true }))
vi.mock("@/contexts/SessionContext", () => ({
  useSessionContextOptional: () => ({ session: { sessionId: "lead" }, permissions: { send: chat.canSend } }),
  useSessionChatContextOptional: () => (chat.present ? { chat: { sendMessage: chat.sendMessage } } : null),
}))

import CogpitBlock from "../CogpitBlock"
import { CogpitBlockScope } from "../kinds"
import { setActiveIdentity, __resetIdentityForTest } from "@/lib/device"

/** A decisions block as one reply carries it. */
function inReply(messageKey: string, source = DECISIONS) {
  return (
    <CogpitBlockScope.Provider value={{ messageKey }}>
      <CogpitBlock kind="decisions" fallback={null} source={source} />
    </CogpitBlockScope.Provider>
  )
}

const DECISIONS = [
  "- id: sharp",
  "  question: Bump sharp to 0.34?",
  "  options: [Approve, Later]",
  "  recommended: Approve",
  "- id: sentry",
  "  question: Run sentry-cli login today?",
  "  options: [Now, Later]",
].join("\n")

beforeEach(() => {
  localStorage.clear()
  chat.sendMessage.mockReset().mockResolvedValue(true)
  chat.present = true
  chat.canSend = true
})
afterEach(() => { cleanup(); __resetIdentityForTest(); window.history.replaceState(null, "", "/") })

describe("CogpitBlock", () => {
  it("keeps submitted answers separate for each account and device", async () => {
    setActiveIdentity("first-user")
    const { unmount } = render(inReply("reply-1"))
    fireEvent.keyDown(screen.getByRole("region", { name: "2 decisions" }), { key: "Enter" })
    fireEvent.keyDown(screen.getByRole("region", { name: "2 decisions" }), { key: "Enter", metaKey: true })
    await waitFor(() => expect(screen.getByText("Sent")).toBeInTheDocument())
    unmount()
    setActiveIdentity("second-user")
    const second = render(inReply("reply-1"))
    expect(screen.getByText("0 of 2 answered")).toBeInTheDocument()
    second.unmount()
    setActiveIdentity("first-user")
    window.history.replaceState(null, "", "/d/remote/")
    render(inReply("reply-1"))
    expect(screen.getByText("0 of 2 answered")).toBeInTheDocument()
  })

  it("keeps repeated blocks in one reply independent", async () => {
    render(
      <CogpitBlockScope.Provider value={{ messageKey: "reply-1" }}>
        <CogpitBlock kind="decisions" fallback={null} source={DECISIONS} occurrence="10" />
        <CogpitBlock kind="decisions" fallback={null} source={DECISIONS} occurrence="200" />
      </CogpitBlockScope.Provider>,
    )
    const [first, second] = screen.getAllByRole("region", { name: "2 decisions" })
    fireEvent.keyDown(first!, { key: "Enter" })
    fireEvent.keyDown(first!, { key: "Enter", metaKey: true })
    await waitFor(() => expect(within(first!).getByText("Sent")).toBeInTheDocument())
    expect(within(second!).getByText("0 of 2 answered")).toBeInTheDocument()
  })
  it("draws a status block as a bar and labelled values", () => {
    render(<CogpitBlock kind="status" fallback={<pre>code</pre>} source={"title: Wave 3\nprogress: { done: 35, total: 99 }\nvalues:\n  - { label: Blocked on you, value: 4, tone: warning }"} />)
    expect(screen.getByRole("progressbar", { name: "35 of 99 done" })).toBeInTheDocument()
    expect(screen.getByText("35%")).toBeInTheDocument()
    expect(screen.getByText("Blocked on you")).toHaveClass("text-warning")
  })

  it("draws a checklist with each item's state", () => {
    render(<CogpitBlock kind="checklist" fallback={<pre>code</pre>} source={"- { text: Rebase, state: done }\n- { text: Apply ruleset, state: blocked, note: 42m }\n- Open the PR"} />)
    expect(screen.getByText("1 of 3")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Blocked" })).toBeInTheDocument()
    expect(screen.getByText("42m")).toBeInTheDocument()
  })

  it("shows the code as written when the block does not read as its kind", () => {
    render(<CogpitBlock kind="status" fallback={<pre>the original code</pre>} source="nothing useful" />)
    expect(screen.getByText("the original code")).toBeInTheDocument()
  })

  it("collects answers in any order and sends them as one message", async () => {
    render(<CogpitBlock kind="decisions" fallback={null} source={DECISIONS} />)
    const block = screen.getByRole("region", { name: "2 decisions" })
    expect(within(block).getByRole("button", { name: "Send 0 answers" })).toBeDisabled()

    const sharp = block.querySelector("[data-decision=sharp]") as HTMLElement
    fireEvent.click(within(sharp).getByRole("button", { name: "Later" }))
    expect(within(block).getByText("1 of 2 answered")).toBeInTheDocument()

    fireEvent.click(within(block).getByRole("button", { name: "Send 1 answer" }))
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("Decisions:\n- sharp: Bump sharp to 0.34? Later"))
    expect(await within(block).findByText("Sent")).toBeInTheDocument()
  })

  it("answers with the keyboard: a number picks, Enter takes the recommendation, ⌘Enter sends", async () => {
    render(<CogpitBlock kind="decisions" fallback={null} source={DECISIONS} />)
    const block = screen.getByRole("region", { name: "2 decisions" })
    fireEvent.keyDown(block, { key: "Enter" })
    fireEvent.keyDown(block, { key: "2" })
    expect(within(block).getByText("2 of 2 answered")).toBeInTheDocument()

    fireEvent.keyDown(block, { key: "Enter", metaKey: true })
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledWith("Decisions:\n- sharp: Bump sharp to 0.34? Approve\n- sentry: Run sentry-cli login today? Later"))
  })

  it("sends once however often ⌘Enter is pressed while the send is in flight", async () => {
    let finish!: (sent: boolean) => void
    chat.sendMessage.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve }))
    render(inReply("reply-1"))
    const block = screen.getByRole("region", { name: "2 decisions" })
    fireEvent.keyDown(block, { key: "Enter" })
    fireEvent.keyDown(block, { key: "Enter", metaKey: true })
    fireEvent.keyDown(block, { key: "Enter", metaKey: true })
    finish(true)
    await waitFor(() => expect(within(block).getByText("Sent")).toBeInTheDocument())
    expect(chat.sendMessage).toHaveBeenCalledOnce()
  })

  it("asks a later reply's identical questions again", async () => {
    const { unmount } = render(inReply("reply-1"))
    fireEvent.keyDown(screen.getByRole("region", { name: "2 decisions" }), { key: "Enter" })
    fireEvent.keyDown(screen.getByRole("region", { name: "2 decisions" }), { key: "Enter", metaKey: true })
    await waitFor(() => expect(screen.getByText("Sent")).toBeInTheDocument())
    unmount()

    render(inReply("reply-2"))
    expect(screen.getByText("0 of 2 answered")).toBeInTheDocument()
  })

  it("moves on to the next decision after a click, so the keyboard answers that one", () => {
    render(inReply("reply-1"))
    const block = screen.getByRole("region", { name: "2 decisions" })
    const sharp = block.querySelector("[data-decision=sharp]") as HTMLElement
    fireEvent.click(within(sharp).getByRole("button", { name: "Later" }))
    fireEvent.keyDown(block, { key: "1" })
    const sentry = block.querySelector("[data-decision=sentry]") as HTMLElement
    expect(sentry).toHaveTextContent("Now")
    expect(within(sharp).queryByRole("button", { name: "Approve recommended" })).not.toBeInTheDocument()
    expect(within(block).getByText("2 of 2 answered")).toBeInTheDocument()
  })

  it("keeps the answers across a reload, and offers nothing to a reader who cannot send", () => {
    const { unmount } = render(<CogpitBlock kind="decisions" fallback={null} source={DECISIONS} />)
    fireEvent.click(screen.getAllByRole("button", { name: /Approve/ })[0]!)
    unmount()

    chat.canSend = false
    render(<CogpitBlock kind="decisions" fallback={null} source={DECISIONS} />)
    expect(screen.getByText("1 of 2 answered")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Now" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument()
  })
})
