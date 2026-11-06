import { afterEach, describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { InverseColorScheme } from "@/components/InverseColorScheme"
import { useIsDarkMode } from "@/hooks/useIsDarkMode"

function Mode({ label }: { label: string }) {
  return <span data-testid={label}>{useIsDarkMode() ? "dark" : "light"}</span>
}

afterEach(() => {
  document.documentElement.className = ""
})

describe("InverseColorScheme", () => {
  it.each([
    ["dark", "light"],
    ["", "dark"],
  ])("draws content inside on the opposite theme of %s", (pageClass, inside) => {
    if (pageClass) document.documentElement.classList.add(pageClass)

    render(
      <>
        <Mode label="page" />
        <InverseColorScheme className="rounded-2xl">
          <Mode label="inside" />
        </InverseColorScheme>
      </>,
    )

    expect(screen.getByTestId("page")).toHaveTextContent(pageClass ? "dark" : "light")
    expect(screen.getByTestId("inside")).toHaveTextContent(inside)
    expect(screen.getByTestId("inside").parentElement).toHaveClass("color-scheme-inverse", "rounded-2xl")
  })
})
