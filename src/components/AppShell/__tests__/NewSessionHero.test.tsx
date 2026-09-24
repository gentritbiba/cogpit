import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NewSessionHeadline, type HeadlineProjectSwitcher } from "../NewSessionHero"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, authUrl: (path: string) => path }))
vi.mock("@/hooks/useProjectNames", () => ({ useProjectNames: () => ({ names: {} }) }))
vi.mock("@/hooks/useFolderHostName", () => ({ useFolderHostName: () => null }))
vi.mock("@/components/ProjectFavicon", () => ({
  ProjectFavicon: ({ fallback }: { fallback: ReactNode }) => <>{fallback}</>,
}))
// The real popover portals its content out of the heading and toggles on the
// trigger; the stand-in does the same inline, so heading text stays honest
// while closed and clicks still open it.
vi.mock("@/components/ui/popover", async () => {
  const React = await import("react")
  const Ctx = React.createContext<{ open: boolean; onOpenChange: (open: boolean) => void }>({ open: false, onOpenChange: () => {} })
  return {
    Popover: ({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => (
      <Ctx.Provider value={{ open, onOpenChange }}>{children}</Ctx.Provider>
    ),
    PopoverTrigger: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
      const { open, onOpenChange } = React.useContext(Ctx)
      return <button type="button" {...props} onClick={() => onOpenChange(!open)} />
    },
    PopoverContent: ({ children }: { children: ReactNode }) => {
      const { open } = React.useContext(Ctx)
      return open ? <div data-testid="popover">{children}</div> : null
    },
  }
})

Element.prototype.scrollIntoView = vi.fn()

const projects = [
  { dirName: "-Users-me-code-agent-window", path: "/Users/me/code/agent-window", shortName: "agent-window", sessionCount: 4, lastModified: null },
  { dirName: "-Users-me-code-honest-cms", path: "/Users/me/code/honest-cms", shortName: "honest-cms", sessionCount: 1, lastModified: null },
]

function switcher(overrides: Partial<HeadlineProjectSwitcher> = {}): HeadlineProjectSwitcher {
  return { onNewSession: vi.fn(), onNewFolder: vi.fn(), defaultAgentKind: "codex", ...overrides }
}

beforeEach(() => {
  mocks.authFetch.mockResolvedValue({ ok: true, json: async () => projects })
})

afterEach(cleanup)

describe("NewSessionHeadline", () => {
  it("names the project the session will start in, keeping the heading readable", () => {
    render(<NewSessionHeadline projectPath="/Users/me/code/agent-window" switcher={switcher()} />)

    expect(screen.getByRole("heading", { name: "What should we build in agent-window ?" })).toBeInTheDocument()
  })

  it("shows enough path to tell a worktree from its parent", () => {
    render(<NewSessionHeadline projectPath="/Users/me/code/.worktrees/team-edition" switcher={switcher()} />)

    expect(screen.getByText(".worktrees/team-edition")).toBeInTheDocument()
  })

  it("still asks the question when no project is known yet", () => {
    render(<NewSessionHeadline projectPath={null} switcher={switcher()} />)

    expect(screen.getByRole("heading")).toHaveTextContent("What should we build?")
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.queryByRole("paragraph")).not.toBeInTheDocument()
  })

  it("turns the project name into a switcher that starts the session elsewhere", async () => {
    const user = userEvent.setup()
    const onNewSession = vi.fn()
    render(<NewSessionHeadline projectPath="/Users/me/code/honest-cms" switcher={switcher({ onNewSession })} />)

    const trigger = screen.getByRole("button", { name: "honest-cms" })
    expect(trigger).toHaveAccessibleDescription("Switch project")

    await user.click(trigger)
    const list = within(screen.getByTestId("popover"))
    const current = await list.findByRole("option", { name: /honest-cms/ })
    expect(current).toHaveAttribute("data-checked", "true")

    await user.click(list.getByRole("option", { name: /agent-window/ }))
    expect(onNewSession).toHaveBeenCalledWith("-Users-me-code-agent-window", "/Users/me/code/agent-window")
  })

  it("starts a session in a pasted folder", async () => {
    const user = userEvent.setup()
    const onNewFolder = vi.fn()
    render(<NewSessionHeadline projectPath="/Users/me/code/honest-cms" switcher={switcher({ onNewFolder })} />)

    await user.click(screen.getByRole("button", { name: "honest-cms" }))
    await user.type(screen.getByPlaceholderText("Search projects, paste a folder path, or browse"), "/workspace/fresh")
    await user.click(screen.getByRole("option", { name: /Start in this folder/ }))

    expect(onNewFolder).toHaveBeenCalledWith("/workspace/fresh")
  })
})
