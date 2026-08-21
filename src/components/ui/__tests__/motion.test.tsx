import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Alert } from "../alert"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible"
import { Empty } from "../empty"
import { Progress } from "../progress"
import { Skeleton } from "../skeleton"

describe("shared UI motion", () => {
  it("uses Base UI's measured height and transition states for collapsibles", () => {
    const { container } = render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Details</CollapsibleTrigger>
        <CollapsibleContent>Content</CollapsibleContent>
      </Collapsible>,
    )

    expect(container.querySelector("[data-slot=collapsible-content]")).toHaveClass(
      "h-[var(--collapsible-panel-height)]",
      "motion-safe:data-starting-style:h-0",
      "motion-safe:data-ending-style:h-0",
      "motion-reduce:transition-none",
    )
  })

  it("keeps feedback animations finite and reduced-motion safe", () => {
    const { container } = render(
      <>
        <Skeleton />
        <Empty />
        <Alert>Notice</Alert>
        <Progress value={50} />
      </>,
    )

    expect(container.querySelector("[data-slot=skeleton]")).not.toHaveClass(
      "animate-pulse",
    )
    expect(container.querySelector("[data-slot=skeleton]")).toHaveClass(
      "motion-safe:animate-in",
      "motion-reduce:animate-none",
    )
    expect(container.querySelector("[data-slot=empty]")).toHaveClass(
      "motion-safe:animate-in",
      "motion-reduce:animate-none",
    )
    expect(container.querySelector("[data-slot=alert]")).toHaveClass(
      "motion-safe:animate-in",
      "motion-reduce:animate-none",
    )
    expect(container.querySelector("[data-slot=progress-indicator]")).toHaveClass(
      "transition-[width]",
      "motion-reduce:transition-none",
    )
  })
})
