import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AllowanceRecovery } from "../AllowanceRecovery"
import { RECOVERY_MESSAGE, type RecoveryStatus } from "../../../shared/contracts/recovery"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: (...args: unknown[]) => mocks.fetch(...args) }))
vi.mock("@/lib/openTerminal", () => ({ openProjectTerminal: vi.fn() }))
vi.mock("@/lib/device", () => ({ isRemoteDeviceActive: () => false }))
const block = { limit: "five_hour", resetsAt: 1_800_000_060, lowPriority: false }
const offered: RecoveryStatus = { offer: { id: "server-offer-1", block, dueAt: block.resetsAt * 1000 }, run: null, support: "personal", message: RECOVERY_MESSAGE }
const scheduled: RecoveryStatus = { ...offered, offer: null, run: { id: "occurrence-1", block, state: "scheduled", dueAt: block.resetsAt * 1000 } }
const reply = (data: RecoveryStatus) => new Response(JSON.stringify(data), { status: 200 })
function mount(props: Partial<Parameters<typeof AllowanceRecovery>[0]> = {}) {
  return render(<AllowanceRecovery sessionId="session-1" dirName="-work-app" fileName="session-1.jsonl" cwd="/work/app" terminal={false} canResume block={block} {...props} />)
}
beforeEach(() => { mocks.fetch.mockReset().mockImplementation(async () => reply(offered)) })
afterEach(() => { vi.restoreAllMocks() })

it("offers accessible explicit consent with the exact continuation payload", async () => {
  mount()
  const button = await screen.findByRole("button", { name: "Resume when limit resets" })
  expect(screen.getByLabelText("Usage limit recovery")).toHaveTextContent(RECOVERY_MESSAGE)
  expect(mocks.fetch.mock.calls.every(([, init]) => !init.method)).toBe(true)
  mocks.fetch.mockResolvedValueOnce(reply(scheduled))
  fireEvent.click(button)
  await screen.findByRole("button", { name: "Cancel scheduled resume" })
  const mutation = mocks.fetch.mock.calls.find(([, init]) => init.method === "POST")!
  expect(JSON.parse(mutation[1].body)).toEqual({ sessionId: "session-1", action: "enable", offerId: "server-offer-1" })
  expect(screen.queryByRole("button", { name: "Resume when limit resets" })).toBeNull()
})

it("reloads pending server consent without a live rate-limit event", async () => {
  mocks.fetch.mockResolvedValue(reply(scheduled))
  mount({ block: null })
  expect(await screen.findByRole("button", { name: "Cancel scheduled resume" })).toBeEnabled()
  expect(screen.getByText(/Resume is scheduled/)).toBeInTheDocument()
})

it("cancels through the server and keeps the cancellation visible", async () => {
  mocks.fetch.mockResolvedValueOnce(reply(scheduled))
  mount()
  const button = await screen.findByRole("button", { name: "Cancel scheduled resume" })
  mocks.fetch.mockResolvedValueOnce(reply({ ...scheduled, run: { ...scheduled.run!, state: "cancelled", reason: "Recovery consent was dismissed" } }))
  fireEvent.click(button)
  await screen.findByText("Recovery consent was dismissed")
  expect(screen.queryByRole("button", { name: "Cancel scheduled resume" })).toBeNull()
  expect(JSON.parse(mocks.fetch.mock.calls[1]![1].body)).toEqual({ sessionId: "session-1", action: "cancel" })
})

it("shows held authorization and can explicitly reauthorize", async () => {
  mocks.fetch.mockResolvedValueOnce(reply({ ...scheduled, support: "none", run: { ...scheduled.run!, state: "held", hold: "reauthorize", reason: "Sign in again" } }))
  mount({ block: null })
  fireEvent.click(await screen.findByRole("button", { name: "Reauthorize continuation" }))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
  expect(JSON.parse(mocks.fetch.mock.calls[1]![1].body).action).toBe("reauthorize")
})

it("surfaces uncertain native delivery without an automatic retry control", async () => {
  mocks.fetch.mockResolvedValue(reply({ ...scheduled, run: { ...scheduled.run!, state: "unknown" } }))
  mount({ block: null })
  expect(await screen.findByText(/Delivery is uncertain/)).toHaveTextContent(/native history/)
  expect(screen.queryByRole("button", { name: /resume|reauthorize|cancel/i })).toBeNull()
})

it("requires server validation rather than deriving consent from the banner date", async () => {
  mocks.fetch.mockResolvedValue(reply({ ...offered, offer: null }))
  mount()
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
  expect(screen.queryByRole("button", { name: "Resume when limit resets" })).toBeNull()
})

it("keeps recovery actions unavailable to a viewer", async () => {
  mount({ canResume: false })
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled())
  expect(screen.queryByRole("button", { name: /resume/i })).toBeNull()
})

it("explains editions that require a return and live reauthorization", async () => {
  mocks.fetch.mockResolvedValue(reply({ ...offered, support: "none" }))
  mount()
  expect(await screen.findByText(/return and reauthorize after reset/)).toBeInTheDocument()
})

it("disables duplicate clicks while consent is pending and reports denial", async () => {
  mount()
  const button = await screen.findByRole("button", { name: "Resume when limit resets" })
  let deny: (response: Response) => void = () => {}
  mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { deny = resolve }))
  fireEvent.click(button); fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  deny(new Response(JSON.stringify({ error: "Session access changed" }), { status: 403 }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Session access changed")
  expect(button).toBeEnabled()
})

it("does not apply a late mutation after a session switch", async () => {
  const mounted = mount()
  const button = await screen.findByRole("button", { name: "Resume when limit resets" })
  let finish: (response: Response) => void = () => {}
  mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  fireEvent.click(button)
  mocks.fetch.mockResolvedValue(reply({ ...offered, offer: null }))
  mounted.rerender(<AllowanceRecovery sessionId="session-2" dirName="-work-app" fileName="session-2.jsonl" cwd={null} terminal={false} canResume block={null} />)
  finish(reply(scheduled))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(3))
  expect(screen.queryByText(/Resume is scheduled/)).toBeNull()
})

it("clears prior account consent immediately when identity changes", async () => {
  mocks.fetch.mockResolvedValueOnce(reply(scheduled))
  mount({ block: null })
  await screen.findByRole("button", { name: "Cancel scheduled resume" })
  mocks.fetch.mockResolvedValue(reply({ ...offered, offer: null }))
  fireEvent(window, new Event("cogpit-identity-changed"))
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel scheduled resume" })).toBeNull())
})

it("does not let an older status read overwrite accepted consent", async () => {
  mount()
  const button = await screen.findByRole("button", { name: "Resume when limit resets" })
  let finish: (response: Response) => void = () => {}
  mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  fireEvent(window, new Event("online"))
  mocks.fetch.mockResolvedValueOnce(reply(scheduled))
  fireEvent.click(button)
  await screen.findByRole("button", { name: "Cancel scheduled resume" })
  await act(async () => { finish(reply(offered)) })
  expect(screen.getByRole("button", { name: "Cancel scheduled resume" })).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Resume when limit resets" })).toBeNull()
})

it("shows server-observed future offers after refresh without a live stream block", async () => {
  mount({ block: null })
  expect(await screen.findByRole("button", { name: "Resume when limit resets" })).toBeEnabled()
})

it("explains delivery already started instead of offering a scheduled cancellation", async () => {
  mocks.fetch.mockResolvedValue(reply({ ...scheduled, run: { ...scheduled.run!, state: "admitted", command: { id: "command-1", state: "delivered", conversationId: "conversation", sessionId: "session-1", bindingRevision: 1, intent: "queue", createdAt: 1, updatedAt: 1, position: 1 } } }))
  mount({ block: null })
  expect(await screen.findByText(/Continuation has started/)).toHaveTextContent(/Use Stop/)
  expect(screen.queryByRole("button", { name: "Cancel scheduled resume" })).toBeNull()
})
