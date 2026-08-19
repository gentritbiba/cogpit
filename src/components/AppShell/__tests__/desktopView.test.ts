import { describe, expect, it } from "vitest"
import {
  formatProjectPromptContext,
  resolveDesktopMainView,
  resolveDesktopProjectPath,
} from "../desktopView"

describe("resolveDesktopMainView", () => {
  it("gives config precedence over session and pending content", () => {
    expect(resolveDesktopMainView({
      mainView: "config",
      hasSession: true,
      pendingDirName: "pending",
    })).toBe("config")
  })

  it("shows Mission Control over an open session", () => {
    // The view exists to find what is blocked while you are already deep in
    // another session, so an open session must not hide it.
    expect(resolveDesktopMainView({
      mainView: "mission",
      hasSession: true,
      pendingDirName: "pending",
    })).toBe("mission")
  })

  it("keeps config ahead of Mission Control", () => {
    expect(resolveDesktopMainView({
      mainView: "config",
      hasSession: false,
      pendingDirName: null,
    })).toBe("config")
  })

  it("uses pending content before the dashboard", () => {
    expect(resolveDesktopMainView({
      mainView: "sessions",
      hasSession: false,
      pendingDirName: "pending",
    })).toBe("pending")
  })

  it("uses the dashboard when no more specific view is available", () => {
    expect(resolveDesktopMainView({
      mainView: "sessions",
      hasSession: false,
      pendingDirName: null,
    })).toBe("dashboard")
  })
})

describe("resolveDesktopProjectPath", () => {
  it("uses the same authoritative path order as the desktop config browser", () => {
    expect(resolveDesktopProjectPath({
      sessionCwd: "/session",
      pendingPath: "/pending",
      sessionDirPath: "/source",
      dashboardProjectPath: "/dashboard",
    })).toBe("/session")

    expect(resolveDesktopProjectPath({
      sessionCwd: null,
      pendingPath: "/pending",
      sessionDirPath: "/source",
      dashboardProjectPath: "/dashboard",
    })).toBe("/pending")

    expect(resolveDesktopProjectPath({
      sessionCwd: null,
      pendingPath: null,
      sessionDirPath: "/source",
      dashboardProjectPath: "/dashboard",
    })).toBe("/source")
  })

  it("returns null when no project path is available", () => {
    expect(resolveDesktopProjectPath({})).toBeNull()
  })
})

describe("formatProjectPromptContext", () => {
  it("formats a path-only mention", () => {
    expect(formatProjectPromptContext({ path: "src/App.tsx" })).toBe("@src/App.tsx")
  })

  it("formats a commented range and protects nested code fences", () => {
    expect(formatProjectPromptContext({
      path: "src/example.ts",
      text: "const sample = ```nested```",
      startLine: 3,
      endLine: 7,
      comment: "Please simplify",
    })).toBe(
      "Review request: Please simplify\nsrc/example.ts (lines 3-7)\n````\nconst sample = ```nested```\n````",
    )
  })

  it("uses a singular label for a one-line excerpt", () => {
    expect(formatProjectPromptContext({
      path: "src/example.ts",
      text: "const value = 1",
      startLine: 4,
      endLine: 4,
    })).toContain("(line 4)")
  })
})
