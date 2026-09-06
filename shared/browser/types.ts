export interface BrowserSessionInfo {
  name: string
  isDefault: boolean
  running: boolean
  note: string | null
  createdAt: string | null
  lastUsedAt: string | null
  lastUrl: string | null
  /** Cogpit session that last drove it, from the shim's .driver file. */
  driverSessionId: string | null
}

export interface BrowserStatus {
  installed: boolean
  binaryPath: string | null
  sessions: BrowserSessionInfo[]
}
