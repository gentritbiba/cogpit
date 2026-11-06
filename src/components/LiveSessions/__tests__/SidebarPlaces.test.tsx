import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SidebarPlaces } from "../SidebarPlaces"

afterEach(cleanup)

describe("SidebarPlaces", () => {
  it("shows only the sessions where views cannot be opened", () => {
    render(<SidebarPlaces place="views" views={<p>views list</p>}><p>sessions list</p></SidebarPlaces>)
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
    expect(screen.getByText("sessions list")).toBeInTheDocument()
    expect(screen.queryByText("views list")).not.toBeInTheDocument()
  })

  it("switches between sessions and views", async () => {
    const onPlaceChange = vi.fn()
    const { rerender } = render(
      <SidebarPlaces place="sessions" onPlaceChange={onPlaceChange} views={<p>views list</p>}><p>sessions list</p></SidebarPlaces>,
    )
    expect(screen.getByRole("tab", { name: "Sessions" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("sessions list")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "Views" }))
    expect(onPlaceChange).toHaveBeenCalledWith("views")

    rerender(<SidebarPlaces place="views" onPlaceChange={onPlaceChange} views={<p>views list</p>}><p>sessions list</p></SidebarPlaces>)
    expect(screen.getByText("views list")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText("sessions list")).not.toBeInTheDocument())
  })
})
