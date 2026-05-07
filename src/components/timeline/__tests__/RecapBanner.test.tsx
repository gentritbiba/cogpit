import { describe, it, expect, vi, beforeAll } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { RecapBanner } from "../RecapBanner"

// Mock window.matchMedia — required by downstream components
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe("RecapBanner", () => {
  it("renders the 'Session recap' heading", () => {
    render(<RecapBanner content="All done." />)
    expect(screen.getByText("Session recap")).toBeInTheDocument()
  })

  it("renders the content text when open", () => {
    render(<RecapBanner content="Finished the nav refactor." />)
    expect(screen.getByText(/Finished the nav refactor/)).toBeInTheDocument()
  })

  it("renders markdown headings in the content", () => {
    render(<RecapBanner content="# Last session" />)
    // ReactMarkdown renders the heading without the '#' prefix
    expect(screen.getByText("Last session")).toBeInTheDocument()
  })

  it("starts open by default", () => {
    render(<RecapBanner content="visible content xyz" />)
    expect(screen.getByText(/visible content xyz/)).toBeInTheDocument()
  })

  it("collapses when the header button is clicked", () => {
    render(<RecapBanner content="collapsible text abc" />)
    expect(screen.getByText(/collapsible text abc/)).toBeInTheDocument()

    const button = screen.getByRole("button")
    fireEvent.click(button)

    expect(screen.queryByText(/collapsible text abc/)).toBeNull()
  })

  it("expands again after a second click", () => {
    render(<RecapBanner content="toggle test content" />)
    const button = screen.getByRole("button")

    fireEvent.click(button) // collapse
    expect(screen.queryByText(/toggle test content/)).toBeNull()

    fireEvent.click(button) // expand
    expect(screen.getByText(/toggle test content/)).toBeInTheDocument()
  })
})
