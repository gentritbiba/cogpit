import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { CategorySection } from "@/components/config/CategorySection"

describe("CategorySection", () => {
  it("exposes editable file actions through an accessible context menu", async () => {
    const user = userEvent.setup()
    const item = {
      name: "Deploy",
      path: "/workspace/.claude/commands/deploy.md",
      fileType: "command",
      description: "Deploy the application",
      scope: "project",
      readOnly: false,
    }
    const onRenameItem = vi.fn()
    const onDeleteItem = vi.fn()

    render(
      <CategorySection
        category="commands"
        items={[item]}
        selectedPath={null}
        onSelect={vi.fn()}
        onDeleteItem={onDeleteItem}
        onRenameItem={onRenameItem}
        renamingPath={null}
        renameValue=""
        onRenameValueChange={vi.fn()}
        onRenameSubmit={vi.fn()}
        onRenameCancel={vi.fn()}
        creatingInCategory={null}
        onCreated={vi.fn()}
        onCancelCreate={vi.fn()}
      />,
    )

    const trigger = screen.getByText("Deploy").closest("button")
    expect(trigger).not.toBeNull()
    fireEvent.contextMenu(trigger!)

    await user.click(await screen.findByRole("menuitem", { name: "Rename" }))
    expect(onRenameItem).toHaveBeenCalledWith(item)
  })
})
