import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProjectFavicon } from "../ProjectFavicon"

vi.mock("@/lib/auth", () => ({ authUrl: (url: string) => url }))

const fallback = <span data-testid="fallback">folder</span>

describe("ProjectFavicon", () => {
  it("asks the server for the project's own icon", () => {
    const { container } = render(
      <ProjectFavicon projectPath="/Users/me/code/agent window" fallback={fallback} />,
    )

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/api/project-icon?cwd=%2FUsers%2Fme%2Fcode%2Fagent%20window",
    )
  })

  it("falls back when the project has no icon", () => {
    const { container } = render(
      <ProjectFavicon projectPath="/Users/me/code/plain" fallback={fallback} />,
    )

    fireEvent.error(container.querySelector("img")!)

    expect(screen.getByTestId("fallback")).toBeInTheDocument()
  })

  it("falls back when there is no project path at all", () => {
    render(<ProjectFavicon projectPath={null} fallback={fallback} />)

    expect(screen.getByTestId("fallback")).toBeInTheDocument()
  })

  it("is decorative, so it never doubles the row's label", () => {
    const { container } = render(
      <ProjectFavicon projectPath="/Users/me/code/x" fallback={fallback} />,
    )
    const img = container.querySelector("img")!

    expect(img).toHaveAttribute("alt", "")
    expect(img).toHaveAttribute("aria-hidden", "true")
  })

  it("retries for a different project after one fails", () => {
    const { container, rerender } = render(
      <ProjectFavicon projectPath="/a" fallback={fallback} />,
    )
    fireEvent.error(container.querySelector("img")!)
    expect(screen.getByTestId("fallback")).toBeInTheDocument()

    rerender(<ProjectFavicon projectPath="/b" fallback={fallback} />)

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/api/project-icon?cwd=%2Fb",
    )
  })
})
