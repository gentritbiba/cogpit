import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProjectScopePicker } from "../ProjectScopePicker"
import type { ProjectScopeOption } from "../projectScope"

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="popover">{children}</div>,
}))
vi.mock("@/components/ProjectContextMenu", () => ({
  ProjectContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ProjectFavicon", () => ({
  ProjectFavicon: ({ fallback }: { fallback: ReactNode }) => <>{fallback}</>,
}))

const options: ProjectScopeOption[] = [
  { key: "work/app", customName: "App", dirName: "-work-app", cwd: "/work/app", dirNames: ["-work-app"], total: 12, live: 2, needsYou: 1 },
  { key: "work/lib", dirName: "-work-lib", cwd: "/work/lib", dirNames: ["-work-lib"], total: 3, live: 0, needsYou: 0 },
]

Element.prototype.scrollIntoView = vi.fn()

afterEach(cleanup)

describe("ProjectScopePicker", () => {
  it("describes the all-projects scope and lets the user pick a project", () => {
    const onChange = vi.fn()
    render(<ProjectScopePicker options={options} value={null} focused={null} totalSessions={15} onChange={onChange} />)

    const trigger = screen.getByRole("button", { name: "Choose a project to focus on" })
    expect(trigger).toHaveTextContent("All projects")
    expect(trigger).toHaveTextContent("2 projects, 15 sessions")
    expect(screen.queryByRole("button", { name: /New session in/ })).not.toBeInTheDocument()

    const list = within(screen.getByTestId("popover"))
    const app = list.getByText("App").closest("[cmdk-item]")!
    expect(app).toHaveTextContent("work/app")
    expect(within(app as HTMLElement).getByLabelText("1 session waiting for you")).toBeInTheDocument()
    expect(within(app as HTMLElement).getByLabelText("2 live sessions")).toBeInTheDocument()
    expect(list.getByText("All projects").closest("[cmdk-item]")).toHaveAttribute("data-checked", "true")

    fireEvent.click(app)
    expect(onChange).toHaveBeenCalledWith("work/app")
  })

  it("becomes the focused project's masthead with a new-session action", () => {
    const onChange = vi.fn()
    const onNewSession = vi.fn()
    render(
      <ProjectScopePicker
        options={options}
        value="work/app"
        focused={options[0]}
        totalSessions={15}
        onChange={onChange}
        onNewSession={onNewSession}
        onRenameProject={vi.fn()}
      />,
    )

    const trigger = screen.getByRole("button", { name: "Focused on App. Change project" })
    expect(trigger).toHaveTextContent("App")
    expect(trigger).toHaveTextContent("12 sessions, 2 live")

    fireEvent.click(screen.getByRole("button", { name: "New session in App" }))
    expect(onNewSession).toHaveBeenCalledWith("-work-app", "/work/app")

    fireEvent.click(within(screen.getByTestId("popover")).getByText("All projects"))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it("shows how many sessions in other projects are waiting while focused", () => {
    render(<ProjectScopePicker options={options} value="work/lib" focused={options[1]} totalSessions={15} onChange={vi.fn()} />)
    expect(screen.getByLabelText("1 session in another project is waiting for you")).toHaveTextContent("1")
    cleanup()

    render(<ProjectScopePicker options={options} value="work/app" focused={options[0]} totalSessions={15} onChange={vi.fn()} />)
    expect(screen.queryByLabelText(/in another project/)).not.toBeInTheDocument()
    cleanup()

    render(<ProjectScopePicker options={options} value={null} focused={null} totalSessions={15} onChange={vi.fn()} />)
    expect(screen.queryByLabelText(/in another project/)).not.toBeInTheDocument()
  })

  it("keeps a focused project that has no listed sessions selectable", () => {
    render(<ProjectScopePicker options={options} value="work/gone" focused={null} totalSessions={15} onChange={vi.fn()} onNewSession={vi.fn()} />)

    const trigger = screen.getByRole("button", { name: "Focused on work/gone. Change project" })
    expect(trigger).toHaveTextContent("No sessions listed")
    expect(screen.queryByRole("button", { name: /New session in/ })).not.toBeInTheDocument()
  })
})
