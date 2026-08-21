import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { ScrollBar } from "../scroll-area"
import { Separator } from "../separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs"
import { ToggleGroup, ToggleGroupItem } from "../toggle-group"

describe("orientation-aware UI primitives", () => {
  it("links tabs layout classes to Base UI's orientation attribute", () => {
    const { container } = render(
      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="activity">Content</TabsContent>
      </Tabs>,
    )

    expect(container.querySelector("[data-slot=tabs]")).toHaveClass(
      "data-[orientation=horizontal]:flex-col",
      "has-[>[data-slot=tabs-content]]:grid",
      "[&>[data-slot=tabs-content]]:row-start-2",
    )
    expect(container.querySelector("[data-slot=tabs-list]")).toHaveClass(
      "group-data-[orientation=horizontal]/tabs:h-8",
    )
    expect(container.querySelector("[data-slot=tabs-indicator]")).toHaveClass(
      "w-(--active-tab-width)",
      "translate-x-(--active-tab-left)",
      "motion-reduce:transition-none",
    )
    expect(container.querySelector("[data-slot=tabs-content]")).toHaveClass(
      "motion-safe:data-starting-style:opacity-0",
      "motion-safe:data-ending-style:opacity-0",
    )
  })

  it("uses the same orientation contract for separators and scrollbars", () => {
    const { container } = render(
      <>
        <Separator orientation="vertical" />
        <ScrollAreaPrimitive.Root className="size-20">
          <ScrollAreaPrimitive.Viewport>
            <div className="h-40">Content</div>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar keepMounted />
        </ScrollAreaPrimitive.Root>
      </>,
    )

    expect(screen.getByRole("separator")).toHaveClass(
      "data-[orientation=vertical]:w-px",
    )
    expect(container.querySelector("[data-slot=scroll-area-scrollbar]")).toHaveClass(
      "data-[orientation=vertical]:w-2.5",
    )
  })

  it("stacks vertical toggle groups and uses vertical keyboard navigation", async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ToggleGroup aria-label="Theme" orientation="vertical" defaultValue={["dark"]}>
        <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
        <ToggleGroupItem value="light">Light</ToggleGroupItem>
      </ToggleGroup>,
    )

    expect(container.querySelector("[data-slot=toggle-group]")).toHaveClass(
      "data-[orientation=vertical]:flex-col",
    )

    const dark = screen.getByRole("button", { name: "Dark" })
    dark.focus()
    await user.keyboard("{ArrowDown}")
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Light" })).toHaveFocus()
    })
  })
})
