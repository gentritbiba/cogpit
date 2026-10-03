import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandPaletteHost } from "@/components/CommandPaletteHost"
import { createCommandPaletteProps } from "./commandPaletteProps"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { __resetEditionUiForTest } from "@/edition/registry"
import { installStubListFilter } from "@/__tests__/listFilter"
import { __resetSessionAccessForTest, knownSessionAccess } from "@/lib/sessionAccess"
import { NO_CAPABILITIES } from "../../../shared/contracts/identity"

Element.prototype.scrollIntoView = vi.fn()

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  spawnTerminal: vi.fn(() => "pty_test"),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))
vi.mock("@/contexts/PtyContext", () => ({
  usePty: () => ({
    status: "connected",
    spawnTerminal: mocks.spawnTerminal,
  }),
}))

const projects = [{
  dirName: "-workspace-cogpit",
  path: "/workspace/cogpit",
  shortName: "Cogpit",
  sessionCount: 7,
  lastModified: "2026-07-15T12:00:00.000Z",
}]

const sessions = [{
  dirName: "-workspace-cogpit",
  fileName: "session-1.jsonl",
  sessionId: "session-1",
  projectShortName: "Cogpit",
  aiTitle: "Improve terminal workflow",
  gitBranch: "main",
  cwd: "/workspace/cogpit",
  lastModified: "2026-07-15T12:00:00.000Z",
}]

function response(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
  } as unknown as Response
}

function createProps() {
  return {
    ...createCommandPaletteProps(),
    onOpenProject: vi.fn(),
    onOpenSession: vi.fn(),
    currentProjectDirName: "-workspace-cogpit",
    projectCwd: "/workspace/cogpit",
    onProcessStarted: vi.fn(),
  }
}

describe("CommandPaletteHost", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
    mocks.spawnTerminal.mockClear()
    mocks.authFetch.mockImplementation((url: string) =>
      Promise.resolve(response(url.startsWith("/api/projects") ? projects : sessions)),
    )
  })

  afterEach(() => {
    __resetCapabilitiesForTest()
    __resetSessionAccessForTest()
    __resetEditionUiForTest()
    localStorage.clear()
  })

  it("learns the access of the sessions it lists", async () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { id: "u_bob", username: "bob", displayName: "Bob" },
      capabilities: NO_CAPABILITIES,
    })
    mocks.authFetch.mockImplementation((url: string) => Promise.resolve(response(url.startsWith("/api/projects")
      ? projects
      : [{ ...sessions[0], access: { level: "view", mine: false } }])))
    render(<CommandPaletteHost {...createProps()} />)

    await screen.findByText("Improve terminal workflow")
    expect(knownSessionAccess("session-1")).toBe("view")
  })

  it("lists recent sessions under the session list filter", async () => {
    installStubListFilter("narrow")
    render(<CommandPaletteHost {...createProps()} />)

    expect(await screen.findByText("Improve terminal workflow")).toBeInTheDocument()
    expect(mocks.authFetch).toHaveBeenCalledWith(
      "/api/active-sessions?limit=12&perProject=3&filter=narrow",
      expect.anything(),
    )
  })

  it("loads projects and recent sessions and navigates directly to a session", async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<CommandPaletteHost {...props} />)

    await user.click(await screen.findByText("Improve terminal workflow"))

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
    expect(props.onOpenSession).toHaveBeenCalledWith(
      "-workspace-cogpit",
      "session-1.jsonl",
    )
  })

  it("opens an embedded PTY in the current project and registers it in the process panel", async () => {
    const user = userEvent.setup()
    const props = createProps()
    render(<CommandPaletteHost {...props} />)

    await user.click(screen.getByText("New integrated terminal"))

    expect(mocks.spawnTerminal).toHaveBeenCalledWith({ cwd: "/workspace/cogpit" })
    expect(props.onProcessStarted).toHaveBeenCalledWith({
      id: "pty_test",
      name: "cogpit",
      type: "terminal",
      status: "running",
      source: "/workspace/cogpit",
    })
  })
})
