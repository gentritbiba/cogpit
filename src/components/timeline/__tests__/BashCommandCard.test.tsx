import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolCall } from "../../../../shared/session/types"
import { BashCommandCard } from "../BashCommandCard"

const { openFile, writeText } = vi.hoisted(() => ({
  openFile: vi.fn(),
  writeText: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/capabilities", () => ({ can: () => true }))
vi.mock("@/lib/fileOpener", () => ({ openFile }))
vi.mock("@/hooks/useIsDarkMode", () => ({ useIsDarkMode: () => true }))
vi.mock("@/lib/shiki", () => ({
  getLangFromPath: () => null,
  highlightCode: vi.fn().mockResolvedValue([]),
}))

function commandCall(command: string, result: string | null = "ok"): ToolCall {
  return {
    id: "command-id",
    name: "Bash",
    input: { command },
    result,
    isError: false,
    timestamp: "2026-09-13T12:00:00Z",
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  })
})

describe("command details", () => {
  it("shows the full command and bounded result without a second disclosure", () => {
    const output = Array.from({ length: 12 }, (_, index) => `output ${index + 1}`).join("\n")
    render(<BashCommandCard toolCall={commandCall("bun run test", output)} />)

    expect(screen.getByRole("region", { name: "Bash command" })).toBeInTheDocument()
    expect(screen.getByText("bun run test")).toHaveClass("whitespace-pre-wrap")
    expect(screen.getByText(/output 8/)).toBeInTheDocument()
    expect(screen.queryByText(/output 9/)).toBeNull()
    expect(screen.queryByRole("button", { name: /section:/ })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "+4 lines" }))
    expect(screen.getByText(/output 12/)).toBeInTheDocument()
  })

  it("copies the original complete command", async () => {
    const command = "echo ---SOURCE; cat src/example.ts; echo ---TEST; bun run test"
    render(<BashCommandCard toolCall={commandCall(command, "---SOURCE\nsource\n---TEST\npassed")} />)

    fireEvent.click(screen.getByRole("button", { name: "Copy commands" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command))
    expect(screen.getByRole("button", { name: "Commands copied" })).toBeInTheDocument()
  })

  it("distinguishes an active command from missing historical output", () => {
    const call = commandCall("bun run test", null)
    const { rerender } = render(<BashCommandCard toolCall={call} isAgentActive />)
    expect(screen.getByRole("status")).toHaveTextContent("Command is running. Waiting for output")

    rerender(<BashCommandCard toolCall={call} />)
    expect(screen.getByRole("status")).toHaveTextContent("Output unavailable")
    expect(screen.queryByText("Not run")).toBeNull()
  })

  it("marks empty successful output and failed output explicitly", () => {
    const call = commandCall("bun run test", "")
    const { rerender } = render(<BashCommandCard toolCall={call} />)
    expect(screen.getByText("No output")).toBeInTheDocument()

    rerender(<BashCommandCard toolCall={{ ...call, result: "test failed", isError: true }} />)
    expect(screen.getByText("Error")).toBeInTheDocument()
    expect(screen.getByText("test failed")).toHaveClass("text-destructive")
  })

  it("preserves manual section expansion through live updates and global expansion", () => {
    const call = commandCall("echo ---SOURCE; cat src/example.ts; echo ---TEST; bun run test", "---SOURCE\nsource\n---TEST\npassed")
    const { rerender } = render(<BashCommandCard toolCall={call} />)
    const source = screen.getByRole("button", { name: "SOURCE section: cat src/example.ts" })
    expect(source).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("source")).toBeNull()
    fireEvent.click(source)
    expect(screen.getByText("source")).toBeInTheDocument()

    const updated = { ...call, result: "---SOURCE\nupdated source\n---TEST\npassed" }
    rerender(<BashCommandCard toolCall={updated} />)
    expect(source).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("updated source")).toBeInTheDocument()

    rerender(<BashCommandCard toolCall={updated} expandAll />)
    expect(screen.getByRole("button", { name: "SOURCE section: cat src/example.ts" })).toBe(source)
    expect(screen.getByRole("button", { name: "TEST section: bun run test" })).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText("passed")).toBeInTheDocument()
    expect(source).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(source)
    expect(source).toHaveAttribute("aria-expanded", "true")

    rerender(<BashCommandCard toolCall={updated} expandAll={false} />)
    expect(screen.getByRole("button", { name: "SOURCE section: cat src/example.ts" })).toBe(source)
    expect(source).toHaveAttribute("aria-expanded", "true")
    expect(source).not.toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText("updated source")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "TEST section: bun run test" })).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(source)
    rerender(<BashCommandCard toolCall={updated} expandAll />)
    expect(source).toHaveAttribute("aria-expanded", "true")
    rerender(<BashCommandCard toolCall={updated} expandAll={false} />)
    expect(source).toHaveAttribute("aria-expanded", "false")
  })

  it("keeps absent section output honest while a command is active", () => {
    const call = commandCall("echo ---SOURCE; cat src/example.ts; echo ---TEST; bun run test", null)
    const { rerender } = render(<BashCommandCard toolCall={call} isAgentActive />)
    expect(screen.getAllByText("Output pending")).toHaveLength(2)
    expect(screen.queryByText("Not run")).toBeNull()

    rerender(<BashCommandCard toolCall={{ ...call, result: "---SOURCE\nsource" }} expandAll />)
    expect(screen.getByLabelText("TEST section: bun run test")).toHaveTextContent("Not run")
    expect(screen.queryByText("Output unavailable")).toBeNull()
  })

  it("keeps file references interactive outside section disclosure buttons", () => {
    const call = commandCall("echo ---SOURCE; sed -n 1,80p src/example.ts; echo ---FIND; rg -n needle src", "---SOURCE\nsource\n---FIND\nsrc/example.ts:4:needle")
    render(<BashCommandCard toolCall={call} cwd="/repo" />)
    const fileLink = screen.getByTitle("Open /repo/src/example.ts")
    expect(fileLink.parentElement?.closest("button")).toBeNull()
    fireEvent.click(fileLink)
    expect(openFile).toHaveBeenCalledWith("/repo/src/example.ts", {})
    expect(screen.getByText("L1–80")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "FIND section: rg -n needle src" }))
    fireEvent.click(screen.getByTitle("Open /repo/src/example.ts:4"))
    expect(openFile).toHaveBeenLastCalledWith("/repo/src/example.ts", { line: 4 })
  })
})
