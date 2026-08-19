import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import {
  KEYBINDING_DEFINITIONS,
  resetAllKeybindings,
  setKeybinding,
  shortcutLabel,
} from "@/lib/keybindings"
import { ProjectsView } from "../ProjectsView"

function renderView() {
  return render(
    <ProjectsView
      projects={[]}
      activeSessions={[]}
      loading={false}
      refreshing={false}
      searchFilter=""
      setSearchFilter={vi.fn()}
      fetchError={null}
      selectedProjectDirName={null}
      onRefresh={vi.fn()}
    />
  )
}

afterEach(() => {
  resetAllKeybindings()
})

describe("ProjectsView — keyboard shortcut cheat sheet", () => {
  it("lists shortcuts straight from the keybinding registry", () => {
    renderView()
    expect(screen.getByText("Open command palette")).toBeInTheDocument()
    expect(screen.getByText("Toggle session sidebar")).toBeInTheDocument()
    expect(screen.getByText("Toggle integrated terminal")).toBeInTheDocument()
  })

  it("never lists the same chord twice", () => {
    // A hardcoded row alongside a generated one goes stale the moment the user
    // rebinds it, so the cheat sheet would then contradict itself.
    const { container } = renderView()
    const text = container.textContent ?? ""
    for (const definition of KEYBINDING_DEFINITIONS) {
      const occurrences = text.split(definition.label).length - 1
      expect(occurrences, `"${definition.label}" appears ${occurrences}x`).toBeLessThanOrEqual(1)
    }
  })

  it("keeps the two chords the registry cannot express", () => {
    renderView()
    expect(screen.getByText("Jump to Nth live session")).toBeInTheDocument()
    expect(screen.getByText("Clear search")).toBeInTheDocument()
  })

  it("routes navigation chords through the registry so a rebind is reflected", () => {
    setKeybinding("focusComposer", { key: "j", modKey: true })
    renderView()
    const label = KEYBINDING_DEFINITIONS.find((d) => d.command === "focusComposer")!.label
    expect(shortcutLabel("focusComposer")).toContain("J")
    const row = screen.getByText(label).closest("div")
    expect(row?.textContent).toContain("J")
  })

  it("does not advertise commands the app no longer has", () => {
    renderView()
    expect(screen.queryByText(/voice input/i)).not.toBeInTheDocument()
  })

  it("shows the user's rebound chord instead of the default", () => {
    setKeybinding("toggleSidebar", { key: "y", modKey: true })
    renderView()
    const row = screen.getByText("Toggle session sidebar").closest("div")
    expect(row?.textContent).toContain("Y")
  })
})
