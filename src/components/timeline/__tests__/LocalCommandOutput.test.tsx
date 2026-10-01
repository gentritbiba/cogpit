import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { LocalCommandBlock } from "../LocalCommandOutput"

describe("LocalCommandBlock", () => {
  it("shows what the command printed, without the transcript tags or terminal styling", () => {
    render(
      <LocalCommandBlock content={"<local-command-stdout>\u001b[1mCurrent session:\u001b[0m 41% used\nCurrent week: 12% used</local-command-stdout>"} />,
    )

    expect(screen.getByText(/Current session: 41% used\s+Current week: 12% used/)).toBeInTheDocument()
  })

  it("renders nothing for a record with no output", () => {
    const { container } = render(<LocalCommandBlock content="" />)
    expect(container).toBeEmptyDOMElement()
  })
})
