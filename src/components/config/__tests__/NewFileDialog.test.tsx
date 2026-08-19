import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NewFileDialog } from "@/components/config/NewFileDialog"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

describe("NewFileDialog", () => {
  beforeEach(() => {
    mocks.authFetch.mockReset()
    mocks.authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ path: "/global/skills/review.md" }),
    })
  })

  it("labels the name field and creates the file in the selected scope", async () => {
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(
      <NewFileDialog
        globalDir="/global/skills"
        projectDir="/workspace/.claude/skills"
        fileType="skill"
        onCreated={onCreated}
        onCancel={vi.fn()}
      />,
    )

    const nameInput = screen.getByRole("textbox", { name: "Skill name" })
    expect(screen.getByRole("button", { name: "Project" })).toHaveAttribute("aria-pressed", "true")

    await user.click(screen.getByRole("button", { name: "Global" }))
    await user.type(nameInput, "review")
    await user.click(screen.getByRole("button", { name: "Create skill" }))

    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledWith(
      "/api/config-browser/create",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ dir: "/global/skills", fileType: "skill", name: "review" }),
      }),
    ))
    expect(onCreated).toHaveBeenCalledWith("/global/skills/review.md", "skill", "global")
  })
})
