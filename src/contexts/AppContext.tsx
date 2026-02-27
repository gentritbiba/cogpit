import { createContext, useContext, type Dispatch, type ReactNode } from "react"
import type { SessionState, SessionAction } from "@/hooks/useSessionState"

// ── App Config ──────────────────────────────────────────────────────────────

export interface AppConfig {
  configLoading: boolean
  configError: string | null
  claudeDir: string | null
  setClaudeDir: (dir: string | null) => void
  showConfigDialog: boolean
  openConfigDialog: () => void
  handleCloseConfigDialog: () => void
  handleConfigSaved: (newPath: string) => void
  retryConfig: () => void
  networkUrl: string | null
  networkAccessDisabled: boolean
}

// ── Theme ───────────────────────────────────────────────────────────────────

export interface ThemeContext {
  theme: "dark" | "oled" | "light"
  activeTheme: "dark" | "oled" | "light"
  themeClasses: string
  setTheme: (id: "dark" | "oled" | "light") => void
  setPreview: (id: "dark" | "oled" | "light" | null) => void
}

// ── Network Auth ────────────────────────────────────────────────────────────

export interface NetworkAuth {
  isRemote: boolean
  authenticated: boolean
  handleAuthenticated: () => void
  logout: () => void
}

// ── Combined App Context ────────────────────────────────────────────────────

export interface AppContextValue {
  state: SessionState
  dispatch: Dispatch<SessionAction>
  config: AppConfig
  theme: ThemeContext
  networkAuth: NetworkAuth
  isMobile: boolean
}

const AppContext = createContext<AppContextValue | null>(null)

// ── Provider ────────────────────────────────────────────────────────────────

interface AppProviderProps {
  value: AppContextValue
  children: ReactNode
}

export function AppProvider({ value, children }: AppProviderProps): ReactNode {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error("useAppContext must be used within an AppProvider")
  }
  return ctx
}
