import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import type { ReactElement } from "react"
import { AgentMessageCard, agentAccentHue, flattenToPlainText } from "../AgentMessageCard"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { SessionStatus } from "@/lib/sessionStatus"

const mocks = vi.hoisted(() => ({
  inventory: null as { sessions: ActiveSessionInfo[] } | null,
}))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  useSessionInventoryOptional: () => mocks.inventory,
}))

beforeEach(() => {
  mocks.inventory = null
})

function liveSession(fields: Partial<ActiveSessionInfo>): ActiveSessionInfo {
  return {
    dirName: "-Users-x-proj",
    projectShortName: "proj",
    fileName: "session.jsonl",
    sessionId: "session",
    lastModified: "2026-08-25T10:00:00.000Z",
    size: 1,
    ...fields,
  }
}

/** Renders the card under an inventory holding exactly these sessions. */
function renderWithInventory(sessions: Array<Partial<ActiveSessionInfo>>, ui: ReactElement) {
  mocks.inventory = { sessions: sessions.map(liveSession) }
  return render(ui)
}

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

  // The body handed to the card is normally already unwrapped. This feeds it one
  // that is not, because a card that only ever sees clean bodies proves nothing
  // about the defect this feature exists to fix.
  it("never renders the raw envelope", () => {
    const wrapped = `<agent-message from="csp-and-proxy">\n${BODY}\n</agent-message>`
    const { container } = render(
      <AgentMessageCard sender="csp-and-proxy" body={wrapped} timestamp="" />,
    )
    expect(container.textContent).not.toContain("<agent-message")
    expect(container.textContent).not.toContain("</agent-message")
    expect(screen.getByTestId("agent-message-subject").textContent).toContain("payload-batch-2 done")
  })

  it("keeps an envelope tag the body only talks about", () => {
    render(<AgentMessageCard sender="w" body={'Peers send <agent-message from="x"> framing.'} timestamp="" />)
    expect(screen.getByTestId("agent-message-subject").textContent).toContain('<agent-message from="x">')
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
    // Whole class token, not a substring: `toContain` also matches
    // `line-clamp-2x`, a utility Tailwind never emits and that clamps nothing.
    expect(subject).toHaveClass("line-clamp-2")
    expect(preview).toHaveClass("line-clamp-2")
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

  describe("liveness dot", () => {
    const dot = () => screen.queryByTestId("agent-liveness")

    it("stays silent when no inventory is mounted", () => {
      render(<AgentMessageCard sender="w" body="b" timestamp="" />)
      expect(dot()).not.toBeInTheDocument()
    })

    it("stays silent when the sender resolves to nothing", () => {
      renderWithInventory(
        [{ agentName: "someone-else", teamName: "t", agentStatus: "tool_use" }],
        <AgentMessageCard sender="ghost" body="b" timestamp="" />,
      )
      expect(dot()).not.toBeInTheDocument()
    })

    it("shows a dot when exactly one live session matches the sender", () => {
      renderWithInventory(
        [{ agentName: "w", teamName: "t", agentStatus: "tool_use" }],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      expect(dot()).toBeInTheDocument()
    })

    // Agent names are unique inside a team, not across them. Pointing at one of
    // two candidates would be a coin flip dressed up as a fact.
    it("stays silent when two sessions share the sender name", () => {
      renderWithInventory(
        [
          { agentName: "w", teamName: "t1", agentStatus: "tool_use" },
          { agentName: "w", teamName: "t2", agentStatus: "idle" },
        ],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      expect(dot()).not.toBeInTheDocument()
    })

    it("stays silent when the one match has no status to report", () => {
      renderWithInventory(
        [{ agentName: "w", teamName: "t" }],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      expect(dot()).not.toBeInTheDocument()
    })

    it("never matches an unnamed session against an empty sender", () => {
      renderWithInventory(
        [{ agentStatus: "tool_use" }],
        <AgentMessageCard sender="" body="b" timestamp="" />,
      )
      expect(dot()).not.toBeInTheDocument()
    })

    const WORKING: SessionStatus[] = ["thinking", "tool_use", "processing", "compacting", "awaiting_agents"]
    const AT_REST: SessionStatus[] = ["idle", "completed", "deferred"]

    it.each(WORKING)("reads %s as still working", (agentStatus) => {
      renderWithInventory(
        [{ agentName: "w", teamName: "t", agentStatus }],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      expect(dot()?.dataset.live).toBe("working")
    })

    it.each(AT_REST)("reads %s as at rest", (agentStatus) => {
      renderWithInventory(
        [{ agentName: "w", teamName: "t", agentStatus }],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      expect(dot()?.dataset.live).toBe("idle")
    })

    it("pulses amber while the sender is working", () => {
      renderWithInventory(
        [{ agentName: "w", teamName: "t", agentStatus: "tool_use" }],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      expect(dot()?.className).toContain("animate-pulse")
      expect(dot()?.className).toContain("bg-warning")
    })

    it("sits steady and green while the sender is idle", () => {
      renderWithInventory(
        [{ agentName: "w", teamName: "t", agentStatus: "idle" }],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      expect(dot()?.className).not.toContain("animate-pulse")
      expect(dot()?.className).toContain("bg-success")
    })

    it("sits beside the sender name", () => {
      renderWithInventory(
        [{ agentName: "w", teamName: "t", agentStatus: "idle" }],
        <AgentMessageCard sender="w" body="b" timestamp="" />,
      )
      // Without the presence check both sides are null once the dot is gone,
      // and the assertion passes on a card that never renders one.
      expect(dot()).toBeInTheDocument()
      expect(screen.getByText("w").nextElementSibling).toBe(dot())
    })
  })

  describe("reply state", () => {
    const ASKED = "2026-08-21T19:26:25.000Z"
    const ANSWERED = "2026-08-21T19:26:47.000Z"
    const stateLine = () => screen.getByTestId("agent-message-state").textContent

    it("shows the reply summary when the message was answered", () => {
      render(
        <AgentMessageCard
          sender="w"
          body="b"
          timestamp={ASKED}
          reply={{ summary: "Fixed the type error you flagged", timestamp: ANSWERED }}
        />,
      )
      expect(screen.getByText(/Fixed the type error you flagged/)).toBeInTheDocument()
      expect(screen.getByText(/replied/i)).toBeInTheDocument()
    })

    it("measures the reply against the message it answered", () => {
      render(
        <AgentMessageCard
          sender="w"
          body="b"
          timestamp={ASKED}
          reply={{ summary: "done", timestamp: ANSWERED }}
        />,
      )
      expect(stateLine()).toBe('You replied 22s later \u00b7 "done"')
    })

    it("omits the delay when a timestamp cannot be read", () => {
      render(
        <AgentMessageCard sender="w" body="b" timestamp={ASKED} reply={{ summary: "done", timestamp: "" }} />,
      )
      expect(stateLine()).toBe('You replied \u00b7 "done"')
    })

    it("shows a ticking wait only while the session is live", () => {
      render(<AgentMessageCard sender="w" body="b" timestamp={ASKED} isLive />)
      expect(screen.getByText(/Awaiting your reply/i)).toBeInTheDocument()
    })

    it("counts the live wait up from the message, not from mount", () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date("2026-08-21T19:26:55.000Z"))
        render(<AgentMessageCard sender="w" body="b" timestamp={ASKED} isLive />)
        expect(stateLine()).toBe("Awaiting your reply \u00b7 30s")

        act(() => { vi.advanceTimersByTime(5000) })
        expect(stateLine()).toBe("Awaiting your reply \u00b7 35s")
      } finally {
        vi.useRealTimers()
      }
    })

    it("shows a flat never-answered state for a historical session", () => {
      render(<AgentMessageCard sender="w" body="b" timestamp={ASKED} />)
      expect(screen.getByText(/Never answered/i)).toBeInTheDocument()
      expect(screen.queryByText(/Awaiting your reply/i)).not.toBeInTheDocument()
    })

    it("never ticks a counter on a historical session", () => {
      vi.useFakeTimers()
      try {
        // Weeks after the fact: a rising counter here would be noise, not urgency.
        vi.setSystemTime(new Date("2026-09-11T19:26:55.000Z"))
        render(<AgentMessageCard sender="w" body="b" timestamp={ASKED} />)
        expect(stateLine()).toBe("Never answered")

        act(() => { vi.advanceTimersByTime(60_000) })
        expect(stateLine()).toBe("Never answered")
      } finally {
        vi.useRealTimers()
      }
    })

    it("stops waiting once the reply lands", () => {
      render(
        <AgentMessageCard
          sender="w"
          body="b"
          timestamp={ASKED}
          isLive
          reply={{ summary: "done", timestamp: ANSWERED }}
        />,
      )
      expect(screen.queryByText(/Awaiting your reply/i)).not.toBeInTheDocument()
      expect(stateLine()).toBe('You replied 22s later \u00b7 "done"')
    })
  })

  describe("needs-you chip", () => {
    const QUESTION = "payload-batch-2 - one blocking question on finding #1.\nDetail follows."
    const chip = () => screen.queryByText(/needs you/i)

    it("flags an unanswered question", () => {
      render(<AgentMessageCard sender="w" body={QUESTION} timestamp="" />)
      expect(chip()).toBeInTheDocument()
    })

    it("drops the flag once the question was answered", () => {
      render(
        <AgentMessageCard
          sender="w"
          body={QUESTION}
          timestamp=""
          reply={{ summary: "answered", timestamp: "" }}
        />,
      )
      expect(chip()).not.toBeInTheDocument()
    })

    it("does not flag a done report", () => {
      render(<AgentMessageCard sender="w" body="batch-2 done, verify is PASS." timestamp="" />)
      expect(chip()).not.toBeInTheDocument()
    })

    // The two strings below are real subject lines from the session that
    // motivated this feature. They are the only calibration the heuristic has,
    // so a change that flips either one has broken the signal.
    it("flags the real message that announced a blocking question", () => {
      const real =
        "payload-batch-2 (CSP + lenderdesk hardening) — one blocking question on finding #1."
      render(<AgentMessageCard sender="w" body={real} timestamp="" />)
      expect(chip()).toBeInTheDocument()
    })

    it("leaves the real done report unflagged", () => {
      const real =
        "payload-batch-2 done, except the one hunk in src/middleware.ts. bun run verify is PASS."
      render(<AgentMessageCard sender="w" body={real} timestamp="" />)
      expect(chip()).not.toBeInTheDocument()
    })

    it("still flags a question a historical session never answered", () => {
      // Liveness is deliberately not a condition. The footer already separates
      // "Awaiting your reply" from "Never answered"; the chip answers a
      // different question — whether anyone was ever asked for something.
      render(<AgentMessageCard sender="w" body={QUESTION} timestamp="" isLive={false} />)
      expect(chip()).toBeInTheDocument()
    })
  })
})

describe("agentAccentHue", () => {
  // Pinned, not compared against itself: the hue is stored nowhere, so the hash
  // is the whole contract. Two windows, two sessions and two app versions have
  // to agree on a sender's colour, and `f(x) === f(x)` holds for `() => 0`.
  it("gives a sender the same hue every time it is computed", () => {
    expect(agentAccentHue("csp-and-proxy")).toBe(260)
    expect(agentAccentHue("payload-batch-2")).toBe(110)
    expect(agentAccentHue("vehicle-batch")).toBe(80)
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
