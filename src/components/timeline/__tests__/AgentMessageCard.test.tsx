import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AgentMessageCard, agentAccentHue, flattenToPlainText } from "../AgentMessageCard"

const BODY = [
  "payload-batch-2 done, except the one hunk in `src/middleware.ts` I said I'd hand you.",
  "",
  "`bun run verify --workspace payload-app` is PASS across lint, typecheck, test and coverage.",
].join("\n")

describe("AgentMessageCard", () => {
  it("shows the sender", () => {
    render(<AgentMessageCard sender="csp-and-proxy" body={BODY} timestamp="" />)
    expect(screen.getByText("csp-and-proxy")).toBeInTheDocument()
  })

  it("never renders the raw envelope", () => {
    const { container } = render(
      <AgentMessageCard sender="csp-and-proxy" body={BODY} timestamp="" />,
    )
    expect(container.textContent).not.toContain("<agent-message")
  })

  it("splits the first line into a subject and the rest into a preview", () => {
    render(<AgentMessageCard sender="w" body={BODY} timestamp="" />)
    expect(screen.getByTestId("agent-message-subject").textContent)
      .toContain("payload-batch-2 done")
    expect(screen.getByTestId("agent-message-preview").textContent)
      .toContain("is PASS across lint")
  })

  it("reveals the full body on expand", () => {
    render(<AgentMessageCard sender="w" body={BODY} timestamp="" />)
    expect(screen.queryByTestId("agent-message-body")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /expand/i }))
    expect(screen.getByTestId("agent-message-body")).toBeInTheDocument()
  })

  it("gives the same sender the same accent every time", () => {
    const { container: a } = render(<AgentMessageCard sender="w" body="x" timestamp="" />)
    const { container: b } = render(<AgentMessageCard sender="w" body="y" timestamp="" />)
    const railOf = (c: HTMLElement) => c.querySelector("[data-agent-rail]")?.getAttribute("style")
    expect(railOf(a)).toBe(railOf(b))
    expect(railOf(a)).toContain(String(agentAccentHue("w")))
  })

  it("handles a single-line body with no preview", () => {
    render(<AgentMessageCard sender="w" body="just one line" timestamp="" />)
    expect(screen.getByTestId("agent-message-subject").textContent).toContain("just one line")
    expect(screen.queryByTestId("agent-message-preview")).not.toBeInTheDocument()
  })

  it("clamps with CSS instead of slicing the text", () => {
    const longLine = `${"a really long sentence that keeps going and going ".repeat(30)}end.`
    render(<AgentMessageCard sender="w" body={`${longLine}\n\n${longLine}`} timestamp="" />)

    const subject = screen.getByTestId("agent-message-subject")
    const preview = screen.getByTestId("agent-message-preview")
    expect(subject.textContent).toBe(longLine)
    expect(preview.textContent).toBe(longLine)
    expect(subject.className).toContain("line-clamp-2")
    expect(preview.className).toContain("line-clamp-2")
  })

  it("keeps the subject out of the preview", () => {
    render(<AgentMessageCard sender="w" body={"Subject line\nRest of it"} timestamp="" />)
    expect(screen.getByTestId("agent-message-preview").textContent).toBe("Rest of it")
  })

  it("skips leading blank lines when picking the subject", () => {
    render(<AgentMessageCard sender="w" body={"\n\n  real subject\nrest"} timestamp="" />)
    expect(screen.getByTestId("agent-message-subject").textContent).toBe("real subject")
  })

  it("flattens markdown out of the preview", () => {
    const body = [
      "Report",
      "",
      "- ran `bun run test`",
      "- see [the plan](docs/plan.md)",
      "",
      "```ts",
      "const x = 1",
      "```",
    ].join("\n")
    render(<AgentMessageCard sender="w" body={body} timestamp="" />)

    const preview = screen.getByTestId("agent-message-preview").textContent ?? ""
    expect(preview).not.toContain("`")
    expect(preview).not.toContain("](")
    expect(preview).toContain("ran bun run test")
    expect(preview).toContain("see the plan")
    expect(preview).toContain("const x = 1")
  })

  it("shows the body size on the expand affordance", () => {
    render(<AgentMessageCard sender="w" body={"x".repeat(1579)} timestamp="" />)
    expect(screen.getByRole("button", { name: /expand/i }).textContent).toContain("1,579")
  })

  it("renders the expanded body as markdown", () => {
    render(<AgentMessageCard sender="w" body={"# Heading\n\nbody text"} timestamp="" />)
    fireEvent.click(screen.getByRole("button", { name: /expand/i }))
    const body = screen.getByTestId("agent-message-body")
    expect(body.querySelector("h1")?.textContent).toBe("Heading")
    expect(body.textContent).not.toContain("# Heading")
  })

  it("renders a valid timestamp and ignores an unparseable one", () => {
    const { container } = render(
      <AgentMessageCard sender="w" body="x" timestamp="2026-08-25T10:11:12.000Z" />,
    )
    expect(container.textContent).toContain(new Date("2026-08-25T10:11:12.000Z").toLocaleTimeString())

    const { container: bad } = render(<AgentMessageCard sender="w" body="x" timestamp="nope" />)
    expect(bad.textContent).not.toContain("Invalid Date")
  })

  it("accepts the reply and liveness props reserved for later tasks", () => {
    expect(() =>
      render(
        <AgentMessageCard
          sender="w"
          body="x"
          timestamp=""
          reply={{ summary: "answered", timestamp: "2026-08-25T10:11:12.000Z" }}
          isLive
          liveStatus="running"
        />,
      ),
    ).not.toThrow()
  })
})

describe("agentAccentHue", () => {
  it("is stable for the same sender", () => {
    expect(agentAccentHue("csp-and-proxy")).toBe(agentAccentHue("csp-and-proxy"))
  })

  it("spreads different senders across the wheel", () => {
    const senders = ["csp-and-proxy", "payload-batch-2", "team-lead", "docs-sweep", "certified-status-fix"]
    expect(new Set(senders.map(agentAccentHue)).size).toBeGreaterThan(1)
  })

  it("always returns a hue inside the colour wheel", () => {
    for (const sender of ["", "a", "zz-top", "Ω-agent", "x".repeat(300)]) {
      const hue = agentAccentHue(sender)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })
})

describe("flattenToPlainText", () => {
  it("strips fences, backticks, list markers, links and emphasis", () => {
    const input = [
      "# Title",
      "> quoted",
      "- **bold** item",
      "1. _italic_ item",
      "```sh",
      "echo hi",
      "```",
      "[link](https://example.com) and ![shot](a.png)",
    ].join("\n")
    expect(flattenToPlainText(input)).toBe(
      "Title quoted bold item italic item echo hi link and shot",
    )
  })

  it("returns an empty string for whitespace-only input", () => {
    expect(flattenToPlainText("\n \n")).toBe("")
  })
})
