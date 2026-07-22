import { describe, it, expect, vi, beforeAll } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { UserMessage } from "../UserMessage"
import { ImageGalleryProvider } from "../SessionImageGallery"

// Mock window.matchMedia — required by downstream markdown components
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

const TEAMMATE_MSG =
  `<teammate-message teammate_id="team-lead"> Explore the HonestCMS repo and map the AI chat frontend. Be thorough.\nReport:\n1. Full file inventory\n2. The widget components</teammate-message>`

describe("UserMessage — teammate-message rendering", () => {
  it("renders a 'From <teammate>' badge instead of forcing raw view", () => {
    render(<UserMessage content={TEAMMATE_MSG} timestamp="" />)
    expect(screen.getByText("From team-lead")).toBeInTheDocument()
  })

  it("renders the inner body as markdown (not the raw envelope) by default", () => {
    render(<UserMessage content={TEAMMATE_MSG} timestamp="" />)
    // Inner prompt text is visible
    expect(screen.getByText(/Explore the HonestCMS repo/)).toBeInTheDocument()
    // The raw wrapper tag is not shown as literal text by default
    expect(screen.queryByText(/teammate-message/)).toBeNull()
  })

  it("still offers a Show raw toggle for the envelope", () => {
    render(<UserMessage content={TEAMMATE_MSG} timestamp="" />)
    const toggle = screen.getByText("Show raw")
    expect(toggle).toBeInTheDocument()
    fireEvent.click(toggle)
    // Toggling flips the control to Hide raw and drops the badge
    expect(screen.getByText("Hide raw")).toBeInTheDocument()
    expect(screen.queryByText("From team-lead")).toBeNull()
  })

  it("does not show a teammate badge for a plain user message", () => {
    render(<UserMessage content="just a normal message" timestamp="" />)
    expect(screen.getByText(/just a normal message/)).toBeInTheDocument()
    expect(screen.queryByText(/From /)).toBeNull()
    expect(screen.queryByText("Show raw")).toBeNull()
  })
})

describe("UserMessage — image attachments", () => {
  it("renders base64 image blocks as clickable thumbnails", () => {
    render(
      <UserMessage
        content={[
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "cG5n" },
          },
          { type: "text", text: "check this" },
        ]}
        timestamp=""
      />,
    )

    const thumbnail = screen.getByAltText("Attachment 1")
    expect(thumbnail).toHaveAttribute("src", "data:image/png;base64,cG5n")
    fireEvent.click(thumbnail)
    expect(screen.getByRole("dialog", { name: "Image viewer" })).toBeInTheDocument()
    expect(screen.getAllByAltText("Attachment 1")).toHaveLength(2)
  })

  it("opens attachments in the surrounding session gallery", () => {
    render(
      <ImageGalleryProvider
        images={[
          { id: "turn-1", src: "data:image/png;base64,cG5n", alt: "Image from turn 1", label: "Turn 1 · Image 1" },
          { id: "turn-2", src: "data:image/png;base64,bmV4dA==", alt: "Image from turn 2", label: "Turn 2 · Image 1" },
        ]}
      >
        <UserMessage
          content={[
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "cG5n" },
            },
          ]}
          timestamp=""
        />
      </ImageGalleryProvider>,
    )

    fireEvent.click(screen.getByRole("button", { name: "Open attached image 1" }))
    expect(screen.getByRole("img", { name: "Image from turn 1" })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Next image" }))
    expect(screen.getByRole("img", { name: "Image from turn 2" })).toBeInTheDocument()
  })
})
