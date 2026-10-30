import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SavedDraftsPanel, type SavedDraftsPanelProps } from "../SavedDraftsPanel"

function mount(overrides: Partial<SavedDraftsPanelProps> = {}) {
  const props: SavedDraftsPanelProps = { items: [{ id: "draft-1", kind: "stash", text: "Keep the image", textChars: 14, savedAt: "2026-10-30T12:00:00Z", context: [{ kind: "browser", label: "Capture" }], images: [{ mediaType: "image/png", bytes: 3_000_000 }] }],
    onCapture: vi.fn(), onRestore: vi.fn(async () => {}), onRemove: vi.fn(), onBackup: vi.fn(async () => {}), onRetry: vi.fn(), onReset: vi.fn(), onDismissUpload: vi.fn(), onLoadMore: vi.fn(), ...overrides }
  render(<SavedDraftsPanel {...props} />)
  return props
}
describe("Saved drafts plugin workspace", () => {
  it("renders metadata and explicit save/restore/delete/backup controls", () => {
    const props = mount()
    expect(screen.getByRole("region", { name: "Saved drafts" })).toHaveTextContent("1 context items · 1 images")
    fireEvent.click(screen.getByRole("button", { name: "Save and clear draft" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete Keep the image" }))
    expect(props.onCapture).toHaveBeenCalledOnce()
    expect(props.onRemove).toHaveBeenCalledWith("draft-1")
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(screen.queryByText(/Saved prompts/)).not.toBeInTheDocument()
  })
  it.each(["swap", "merge"] as const)("requires an explicit %s after a conflicting restore", async (mode) => {
    const restore = vi.fn().mockRejectedValueOnce(new Error("Current draft has content")).mockResolvedValueOnce(undefined)
    mount({ onRestore: restore })
    fireEvent.click(screen.getByRole("button", { name: "Restore Keep the image" }))
    expect(restore).toHaveBeenCalledWith("draft-1", "replace")
    await screen.findByRole("group", { name: "Restore into existing draft" })
    fireEvent.click(screen.getByRole("button", { name: mode === "swap" ? "Swap drafts" : "Merge drafts" }))
    await waitFor(() => expect(restore).toHaveBeenLastCalledWith("draft-1", mode))
    await waitFor(() => expect(screen.queryByRole("group")).not.toBeInTheDocument())
  })
  it("offers damaged-storage reset only after a successful explicit backup", async () => {
    const props = mount({ error: "Damaged local storage", corrupt: true })
    expect(screen.queryByRole("button", { name: "Reset damaged storage after backup" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Download draft backup" }))
    fireEvent.click(await screen.findByRole("button", { name: "Reset damaged storage after backup" }))
    expect(props.onBackup).toHaveBeenCalledOnce()
    expect(props.onReset).toHaveBeenCalledOnce()
  })
  it("keeps reset unavailable after a failed backup", async () => {
    mount({ corrupt: true, onBackup: vi.fn(async () => { throw new Error("Download unavailable") }) })
    fireEvent.click(screen.getByRole("button", { name: "Download draft backup" }))
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reset damaged storage after backup" })).not.toBeInTheDocument())
  })
  it("preserves interrupted-upload and retry controls and labels unconfirmed sends", () => {
    const props = mount({ items: [{ id: "uncertain", kind: "sending", text: "Unknown receipt", textChars: 15, savedAt: "2026-10-30", context: [], images: [] }], error: "Storage full", pendingUpload: true, hasMore: true })
    expect(screen.getByText(/Unconfirmed send/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss upload notice" }))
    fireEvent.click(screen.getByRole("button", { name: "Retry storage" }))
    fireEvent.click(screen.getByRole("button", { name: "Load more drafts" }))
    expect(props.onDismissUpload).toHaveBeenCalledOnce()
    expect(props.onRetry).toHaveBeenCalledOnce()
    expect(props.onLoadMore).toHaveBeenCalledOnce()
  })
})
