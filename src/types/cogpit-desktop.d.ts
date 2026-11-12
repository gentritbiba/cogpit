import type { DesktopPerformanceSnapshot } from "../../shared/contracts/performance"

declare global {
  type DesktopUpdateState =
    | { status: "idle" }
    | { status: "available"; version: string; url: string; via: "download" | "package-manager" }
    | { status: "ready"; version: string; asksForPassword: boolean }
    | { status: "failed"; version: string; message: string; url: string }

  interface DesktopUpdater {
    getState: () => Promise<DesktopUpdateState>
    onState: (cb: (state: DesktopUpdateState) => void) => () => void
    install: () => Promise<void>
    dismissVersion: (version: string) => void
  }

  /** What the desktop app adds to the page (`src/desktop/bridge.ts`); absent in a browser. */
  interface CogpitDesktop {
    platform: "macos" | "windows" | "linux"
    performance: {
      getSnapshot: () => Promise<DesktopPerformanceSnapshot>
    }
    updater: DesktopUpdater
  }

  interface Window {
    cogpitDesktop?: CogpitDesktop
  }
}

export {}
