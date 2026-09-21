import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppStatusToasts } from "@/components/AppStatusToasts"

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

vi.mock("sonner", () => ({
  Toaster: ({ theme }: { theme: string }) => <div data-testid="toaster" data-theme={theme} />,
  toast: mocks,
}))

describe("AppStatusToasts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ["layered-light", "light"], ["layered", "dark"], ["light", "light"], ["dark", "dark"], ["oled", "dark"],
  ] as const)("uses %s presentation for status toasts", (theme, mode) => {
    render(<AppStatusToasts activeError={null} modelFallbackNotice={null} dismissModelFallbackNotice={vi.fn()} connectionLost={false} theme={theme} />)
    expect(screen.getByTestId("toaster")).toHaveAttribute("data-theme", mode)
  })

  it("publishes errors, model fallbacks, and connection failures with stable IDs", async () => {
    const clearError = vi.fn()
    const dismissFallback = vi.fn()

    render(
      <AppStatusToasts
        activeError="Unable to load session"
        clearActiveError={clearError}
        modelFallbackNotice="Using the default model"
        dismissModelFallbackNotice={dismissFallback}
        connectionLost
        theme="dark"
      />,
    )

    await waitFor(() => {
      expect(mocks.error).toHaveBeenCalledWith(
        "Unable to load session",
        expect.objectContaining({
          id: "app-error",
          onDismiss: clearError,
          onAutoClose: clearError,
        }),
      )
      expect(mocks.warning).toHaveBeenCalledWith(
        "Using the default model",
        expect.objectContaining({ id: "model-fallback", onDismiss: dismissFallback }),
      )
      expect(mocks.warning).toHaveBeenCalledWith(
        "Connection lost",
        expect.objectContaining({ id: "session-connection" }),
      )
    })
  })

  it("dismisses status toasts when their conditions clear", async () => {
    render(
      <AppStatusToasts
        activeError={null}
        modelFallbackNotice={null}
        dismissModelFallbackNotice={vi.fn()}
        connectionLost={false}
        theme="light"
      />,
    )

    await waitFor(() => {
      expect(mocks.dismiss).toHaveBeenCalledWith("app-error")
      expect(mocks.dismiss).toHaveBeenCalledWith("model-fallback")
      expect(mocks.dismiss).toHaveBeenCalledWith("session-connection")
    })
  })
})
