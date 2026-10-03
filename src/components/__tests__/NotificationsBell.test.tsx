import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { NotificationsBell } from "@/components/NotificationsBell"
import type { CogpitNotification } from "../../../shared/notifications"

const mocks = vi.hoisted(() => ({
  useNotifications: vi.fn(),
  revealSessionPath: vi.fn(),
}))

vi.mock("@/hooks/useNotifications", () => ({ useNotifications: mocks.useNotifications }))
vi.mock("@/lib/revealSession", () => ({ revealSessionPath: mocks.revealSessionPath }))

const GRANTED: CogpitNotification = {
  id: "n1",
  at: new Date().toISOString(),
  title: "You can now view “Fix the login bug”",
  body: "Open it to follow along",
  kind: "access",
  sessionId: "00000000-0000-4000-8000-000000000001",
  dirName: "-work-alpha",
  readAt: null,
}

describe("NotificationsBell", () => {
  const markRead = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useNotifications.mockReturnValue({
      notifications: [GRANTED],
      unreadCount: 1,
      refresh: vi.fn(),
      markRead,
      markAllRead: vi.fn(),
    })
  })

  it("shows a session the reader was given access to and opens it", async () => {
    const user = userEvent.setup()
    render(<NotificationsBell />)

    await user.click(screen.getByRole("button", { name: "Notifications, 1 unread" }))
    const item = await screen.findByRole("menuitem", { name: /You can now view “Fix the login bug”/ })
    expect(item.querySelector(".lucide-users-round")).not.toBeNull()

    await user.click(item)
    expect(markRead).toHaveBeenCalledWith(["n1"])
    expect(mocks.revealSessionPath).toHaveBeenCalledWith(`/-work-alpha/${GRANTED.sessionId}`)
  })
})
