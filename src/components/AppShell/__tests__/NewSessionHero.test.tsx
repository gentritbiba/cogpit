import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { NewSessionHeadline } from "../NewSessionHero"

describe("NewSessionHeadline", () => {
  it("names the project the session will start in", () => {
    render(<NewSessionHeadline projectPath="/Users/me/code/agent-window" />)

    expect(screen.getByRole("heading")).toHaveTextContent("What should we build in agent-window?")
  })

  it("shows enough path to tell a worktree from its parent", () => {
    render(<NewSessionHeadline projectPath="/Users/me/code/.worktrees/team-edition" />)

    expect(screen.getByText(".worktrees/team-edition")).toBeInTheDocument()
  })

  it("still asks the question when no project is known yet", () => {
    render(<NewSessionHeadline projectPath={null} />)

    expect(screen.getByRole("heading")).toHaveTextContent("What should we build?")
    expect(screen.queryByRole("paragraph")).not.toBeInTheDocument()
  })
})
