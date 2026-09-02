import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"

import { CliBadge } from "../CliBadge"
import { LinkIndicator } from "../LinkIndicator"

describe("CliBadge", () => {
  it("marks an entry every CLI loads", () => {
    render(<CliBadge cli={["claude", "codex", "copilot"]} />)

    expect(screen.getByTitle("Loaded by Claude Code")).toHaveTextContent("C")
    expect(screen.getByTitle("Loaded by Codex CLI")).toHaveTextContent("X")
    // Copilot used to be unrepresentable here: an unguarded lookup on a
    // two-agent map threw the moment the server tagged an entry with it.
    expect(screen.getByTitle("Loaded by GitHub Copilot CLI")).toHaveTextContent("G")
  })

  it("marks an entry only one CLI loads", () => {
    render(<CliBadge cli={["codex"]} />)

    expect(screen.queryByTitle("Loaded by Claude Code")).toBeNull()
    expect(screen.getByTitle("Loaded by Codex CLI")).toBeInTheDocument()
  })

  it("flags a shared-source entry that neither CLI loads", () => {
    render(<CliBadge cli={[]} variant="full" />)

    expect(
      screen.getByTitle(
        "Present in the shared source directory but not linked into any CLI",
      ),
    ).toHaveTextContent("unlinked")
  })

  it("renders nothing when CLI attribution is unknown", () => {
    const { container } = render(<CliBadge />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe("LinkIndicator", () => {
  it("shows the target a symlinked entry resolves to", () => {
    render(<LinkIndicator linkTarget="/home/me/.agents/skills/commit/SKILL.md" variant="full" />)

    const indicator = screen.getByTitle("Symlink → /home/me/.agents/skills/commit/SKILL.md")
    expect(indicator).toHaveTextContent("→ /home/me/.agents/skills/commit/SKILL.md")
  })

  it("renders nothing for a file that is not a symlink", () => {
    const { container } = render(<LinkIndicator />)

    expect(container).toBeEmptyDOMElement()
  })
})
