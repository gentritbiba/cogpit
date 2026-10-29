type ElectronUpdateState =
  | { status: "idle" }
  | { status: "available"; version: string; url: string; via: "download" | "package-manager" }
  | { status: "ready"; version: string; asksForPassword: boolean }
  | { status: "failed"; version: string; message: string; url: string }

interface ElectronUpdaterAPI {
  getState: () => Promise<ElectronUpdateState>
  onState: (cb: (state: ElectronUpdateState) => void) => () => void
  install: () => Promise<void>
  dismissVersion: (version: string) => void
}

interface Window {
  electronUpdater?: ElectronUpdaterAPI
}
