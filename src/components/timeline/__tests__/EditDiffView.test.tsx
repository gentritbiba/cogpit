import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { EditDiffView } from "../EditDiffView"

vi.mock("@/lib/shiki", () => ({ getLangFromPath: () => null }))

describe("EditDiffView line terminators", () => {
  it.each([
    { oldString: "", newString: "\n", count: "+1", opposite: "-1" },
    { oldString: "\n", newString: "", count: "-1", opposite: "+1" },
    { oldString: "", newString: "line\n", count: "+1", opposite: "-1" },
  ])("renders $count for $oldString to $newString", ({ oldString, newString, count, opposite }) => {
    render(<EditDiffView oldString={oldString} newString={newString} filePath="/a" compact={false} />)
    expect(screen.getByText(count)).toBeVisible()
    expect(screen.queryByText(opposite)).not.toBeInTheDocument()
    expect(screen.queryByText("+2")).not.toBeInTheDocument()
  })
})
