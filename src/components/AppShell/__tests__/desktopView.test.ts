import { describe, expect, it } from "vitest"
import {
  projectContextItem,
  resolveDesktopMainView,
  resolveDesktopProjectPath,
} from "../desktopView"

describe("resolveDesktopMainView", () => {
  it("gives config precedence over session and pending content", () => {
    expect(resolveDesktopMainView({
      mainView: "config",
      hasSession: true,
      pendingDirName: "pending",
      extensionViewAvailable: false,
    })).toBe("config")
  })

  it("shows Mission Control over an open session", () => {
    // The view exists to find what is blocked while you are already deep in
    // another session, so an open session must not hide it.
    expect(resolveDesktopMainView({
      mainView: "mission",
      hasSession: true,
      pendingDirName: "pending",
      extensionViewAvailable: false,
    })).toBe("mission")
  })

  it("keeps config ahead of Mission Control", () => {
    expect(resolveDesktopMainView({
      mainView: "config",
      hasSession: false,
      pendingDirName: null,
      extensionViewAvailable: false,
    })).toBe("config")
  })

  it("shows an edition's main view over an open session", () => {
    expect(resolveDesktopMainView({
      mainView: "extension",
      hasSession: true,
      pendingDirName: null,
      extensionViewAvailable: true,
    })).toBe("extension")
  })

  it("falls through an edition's main view the user may no longer open", () => {
    expect(resolveDesktopMainView({
      mainView: "extension",
      hasSession: true,
      pendingDirName: null,
      extensionViewAvailable: false,
    })).toBe("session")
    expect(resolveDesktopMainView({
      mainView: "extension",
      hasSession: false,
      pendingDirName: null,
      extensionViewAvailable: false,
    })).toBe("dashboard")
  })

  it("uses pending content before the dashboard", () => {
    expect(resolveDesktopMainView({
      mainView: "sessions",
      hasSession: false,
      pendingDirName: "pending",
      extensionViewAvailable: false,
    })).toBe("pending")
  })

  it("uses the dashboard when no more specific view is available", () => {
    expect(resolveDesktopMainView({
      mainView: "sessions",
      hasSession: false,
      pendingDirName: null,
      extensionViewAvailable: false,
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

describe("projectContextItem", () => {
  it("leaves a whole file to an @ mention", () => {
    expect(projectContextItem({ path: "src/App.tsx" })).toBeNull()
  })

  it("makes an excerpt typed context with its range and review comment", () => {
    expect(projectContextItem({ path: "src/example.ts", text: "const sample = ```nested```", startLine: 3, endLine: 7, comment: "Please simplify" })).toEqual({
      id: expect.stringMatching(/^ctx-[a-z0-9]{8,32}$/), kind: "file", path: "src/example.ts", text: "const sample = ```nested```", startLine: 3, endLine: 7, comment: "Please simplify",
    })
  })
})
