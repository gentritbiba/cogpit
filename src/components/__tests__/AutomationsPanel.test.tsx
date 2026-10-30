import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AutomationsPanel } from "../AutomationsPanel"
import type { AutomationRun, AutomationTask } from "../../../shared/contracts/automations"
import type { WorkspacePanelProps } from "@/plugin-api"

const mocks = vi.hoisted(() => ({
  allowed: true,
  tasks: [] as AutomationTask[],
  runs: [] as AutomationRun[],
  save: vi.fn(),
  act: vi.fn(),
  actOnRun: vi.fn(),
  fetchRuns: vi.fn(async () => [] as AutomationRun[]),
}))
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => mocks.allowed }))
vi.mock("@/hooks/useModelOptions", () => ({ useModelOptions: () => [{ value: "sonnet", label: "Sonnet" }] }))
vi.mock("@/lib/auth", () => ({ authFetch: async () => new Response(JSON.stringify({ instances: [] })) }))
vi.mock("@/hooks/useAutomations", () => ({
  useAutomations: () => ({
    tasks: mocks.tasks, error: null, refresh: vi.fn(), save: mocks.save, remove: vi.fn(), act: mocks.act, rotate: vi.fn(),
    runs: mocks.fetchRuns, actOnRun: mocks.actOnRun,
  }),
}))

const props = { context: { projectPath: "/repo", openSession: vi.fn() }, active: true, closePanel: vi.fn() } as unknown as WorkspacePanelProps
const task: AutomationTask = {
  id: "trg_0123456789", revision: 1, state: "active", name: "Nightly triage", prompt: "Triage.",
  project: { dirName: "-repo", cwd: "/repo" }, provider: { agent: "claude", instanceId: "default" }, workspace: "project",
  schedule: { kind: "daily", time: "09:00", days: ["mon"], timeZone: "UTC" }, webhook: { enabled: true, scheme: "cogpit", coalesceSeconds: 30 },
  missed: "skip", overlap: "skip", nextRunAt: Date.parse("2026-11-02T09:00:00Z"), authority: { source: "personal", revoked: false },
  webhookUrl: "http://127.0.0.1:19723/api/automation-hooks/trg_0123456789", webhookReachability: "local-only", webhookSecrets: [], createdAt: 1, updatedAt: 1,
}

beforeEach(() => {
  mocks.allowed = true; mocks.tasks = []; mocks.runs = []
  mocks.fetchRuns.mockReset().mockImplementation(async () => mocks.runs)
  mocks.save.mockReset().mockResolvedValue({ task, webhookSecret: "whsec_abc" })
  mocks.act.mockReset().mockResolvedValue({}); mocks.actOnRun.mockReset().mockResolvedValue({})
})

describe("scheduled tasks panel", () => {
  it("refuses callers without host-file and terminal access", () => {
    mocks.allowed = false
    render(<AutomationsPanel {...props} />)
    expect(screen.getByRole("status").textContent).toMatch(/host-file and terminal access/)
    expect(screen.queryByRole("button", { name: /New task/ })).toBeNull()
  })

  it("creates a task with a project-derived folder and shows its webhook secret once", async () => {
    const user = userEvent.setup()
    render(<AutomationsPanel {...props} />)
    await user.click(screen.getByRole("button", { name: /New task/ }))
    await user.type(screen.getByLabelText("Name"), "Nightly triage")
    await user.type(screen.getByLabelText("What the session should do"), "Triage.")
    await user.click(screen.getByLabelText(/Run when a signed delivery arrives/))
    await user.click(screen.getByRole("button", { name: "Create task" }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    const [definition, state] = mocks.save.mock.calls[0]!
    expect(state).toBe("active")
    expect(definition).toMatchObject({ project: { cwd: "/repo", dirName: expect.any(String) }, schedule: { kind: "daily", time: "09:00" }, webhook: { enabled: true, scheme: "cogpit" } })
    expect(await screen.findByText("whsec_abc")).toBeTruthy()
  })

  it("lists a task with its webhook reach, run controls and per-state run actions", async () => {
    const user = userEvent.setup()
    mocks.tasks = [task]
    mocks.runs = [
      { id: "occ_held", trigger: "schedule", state: "held", hold: "reauthorize", dueAt: 1, createdAt: 1, deliveries: 1 },
      { id: "occ_unknown", trigger: "webhook", state: "unknown", dueAt: 2, createdAt: 2, deliveries: 3 },
    ]
    render(<AutomationsPanel {...props} />)
    expect(screen.getByText(task.webhookUrl!)).toBeTruthy()
    expect(screen.getByText(/Reachable only where this machine is/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: /Run now/ }))
    expect(mocks.act).toHaveBeenCalledWith(task.id, "run")
    await user.click(screen.getByRole("button", { name: "History" }))
    expect(await screen.findByText(/3 deliveries/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Reauthorize" }))
    expect(mocks.actOnRun).toHaveBeenCalledWith(task.id, "occ_held", "reauthorize")
    await user.click(screen.getByRole("button", { name: "It did not start" }))
    expect(mocks.actOnRun).toHaveBeenCalledWith(task.id, "occ_unknown", "mark-not-started")
  })

  it("keeps open history current while the panel is shown, and after Run now", async () => {
    vi.useFakeTimers()
    try {
      mocks.tasks = [task]
      render(<AutomationsPanel {...props} />)
      fireEvent.click(screen.getByRole("button", { name: "History" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText("No runs yet.")).toBeTruthy()
      mocks.runs = [{ id: "occ_held", trigger: "schedule", state: "held", hold: "reauthorize", dueAt: 1, createdAt: 1, deliveries: 1 }]
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(screen.getByRole("button", { name: "Reauthorize" })).toBeTruthy()
      const calls = mocks.fetchRuns.mock.calls.length
      fireEvent.click(screen.getByRole("button", { name: /Run now/ }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(mocks.fetchRuns.mock.calls.length).toBeGreaterThan(calls)
    } finally { vi.useRealTimers() }
  })
})
