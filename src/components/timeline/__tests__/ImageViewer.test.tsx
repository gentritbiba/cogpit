import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ImageViewer, type ImageViewerItem } from "../ImageViewer"

const images: ImageViewerItem[] = [
  { id: "one", src: "data:image/png;base64,b25l", alt: "First image", label: "Turn 1 · Image 1" },
  { id: "two", src: "data:image/png;base64,dHdv", alt: "Second image", label: "Turn 2 · Image 1" },
  { id: "three", src: "data:image/png;base64,dGhyZWU=", alt: "Third image", label: "Turn 4 · Image 1" },
]

describe("ImageViewer", () => {
  it("navigates with controls, thumbnails, and arrow keys without wrapping", () => {
    render(<ImageViewer images={images} initialIndex={0} onClose={vi.fn()} />)

    const dialog = screen.getByRole("dialog", { name: "Image viewer" })
    expect(screen.getByRole("img", { name: "First image" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Previous image" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Next image" }))
    expect(screen.getByRole("img", { name: "Second image" })).toBeInTheDocument()

    fireEvent.keyDown(dialog, { key: "ArrowRight" })
    expect(screen.getByRole("img", { name: "Third image" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "View image 1" }))
    expect(screen.getByRole("img", { name: "First image" })).toBeInTheDocument()
  })

  it("supports zoom controls and resets zoom when changing images", async () => {
    render(<ImageViewer images={images} initialIndex={0} onClose={vi.fn()} />)

    const resetZoom = screen.getByRole("button", { name: "Reset zoom" })
    expect(resetZoom).toHaveTextContent("100%")
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }))
    await waitFor(() => expect(resetZoom).not.toHaveTextContent("100%"))
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Next image" }))
    expect(resetZoom).toHaveTextContent("100%")
  })

  it("closes from the dedicated control", () => {
    const onClose = vi.fn()
    render(<ImageViewer images={images.slice(0, 1)} initialIndex={0} onClose={onClose} />)

    fireEvent.click(screen.getByRole("button", { name: "Close image viewer" }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it("renders the image inside a bounded pan/zoom viewport", () => {
    render(<ImageViewer images={images.slice(0, 1)} initialIndex={0} onClose={vi.fn()} />)

    const dialog = screen.getByRole("dialog", { name: "Image viewer" })
    expect(dialog).toHaveClass("overflow-hidden", "sm:max-w-none")

    const viewport = dialog.querySelector(".react-transform-wrapper")
    expect(viewport).toBeTruthy()
    expect(viewport?.querySelector("img")).toBeTruthy()
  })

  it("navigates with a touch swipe when not zoomed in", () => {
    render(<ImageViewer images={images} initialIndex={0} onClose={vi.fn()} />)

    const image = screen.getByRole("img", { name: "First image" })
    fireEvent.pointerDown(image, {
      pointerType: "touch",
      isPrimary: true,
      clientX: 240,
      clientY: 100,
    })
    fireEvent.pointerUp(image, {
      pointerType: "touch",
      isPrimary: true,
      clientX: 120,
      clientY: 108,
    })

    expect(screen.getByRole("img", { name: "Second image" })).toBeInTheDocument()
  })
})
