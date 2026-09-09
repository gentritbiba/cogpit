import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { CompactionMarker } from "../CompactionMarker"

describe("CompactionMarker", () => {
  it("shows trigger and token counts", () => {
    render(<CompactionMarker meta={{ trigger: "manual", preTokens: 511676, postTokens: 188681 }} />)
    expect(screen.getByText("manual · 511.7k → 188.7k")).toBeInTheDocument()
  })

  it("omits the arrow when the boundary recorded no post-compaction count", () => {
    render(<CompactionMarker meta={{ trigger: "auto", preTokens: 167000 }} />)
    expect(screen.getByText("auto · 167.0k")).toBeInTheDocument()
  })

  it("reveals the summary as markdown when expanded", () => {
    render(<CompactionMarker summary={"## Primary request\n\nShip the thing."} />)
    expect(screen.queryByText("Primary request")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("Primary request")).toBeInTheDocument()
    expect(screen.getByText("Ship the thing.")).toBeInTheDocument()
  })

  it("is not expandable when no summary was recorded", () => {
    render(<CompactionMarker meta={{ trigger: "auto", preTokens: 167000 }} />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("Compacted")).toBeInTheDocument()
  })
})
