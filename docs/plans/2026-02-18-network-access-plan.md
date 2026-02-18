# Network Access Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow Cogpit to be accessed from other devices on the local network, with password authentication for remote clients.

**Architecture:** Extend the existing Express server to optionally bind to `0.0.0.0` with auth middleware that skips local requests. Frontend gets a global `authFetch` wrapper and login gate for remote clients. Settings UI gets a toggle + password field.

**Tech Stack:** Express middleware, `crypto.timingSafeEqual`, `os.networkInterfaces()`, React hooks, localStorage

---

## Phase 1: Backend — Config & Auth

### Task 1: Extend AppConfig type and load/save

**Files:**
- Modify: `server/config.ts:18-20` (AppConfig interface)
- Modify: `server/config.ts:28-41` (loadConfig)
- Modify: `server/config.ts:43-46` (saveConfig)

**Step 1: Extend the AppConfig interface**

In `server/config.ts`, change the interface at line 18:

```ts
export interface AppConfig {
  claudeDir: string
  networkAccess?: boolean
  networkPassword?: string
}
```

**Step 2: Update loadConfig to pass through new fields**

Replace the config parsing in `loadConfig` (line 32-34):

```ts
    if (parsed.claudeDir && typeof parsed.claudeDir === "string") {
      cachedConfig = {
        claudeDir: parsed.claudeDir,
        networkAccess: !!parsed.networkAccess,
        networkPassword: parsed.networkPassword || undefined,
      }
      return cachedConfig
    }
```

**Step 3: Verify saveConfig already works**

`saveConfig` uses `JSON.stringify(config)` which will include the new fields automatically. No changes needed.

**Step 4: Commit**

```bash
git add server/config.ts
git commit -m "feat(network): extend AppConfig with networkAccess and networkPassword"
```

---

### Task 2: Add auth middleware

**Files:**
- Modify: `server/helpers.ts` (add `authMiddleware` and `isLocalRequest` functions)

**Step 1: Add imports at top of helpers.ts**

Add `timingSafeEqual` to the existing imports:

```ts
import { timingSafeEqual } from "node:crypto"
```

**Step 2: Add auth helper functions after the `isWithinDir` function (after line 54)**

```ts
// ── Network auth ────────────────────────────────────────────────────────

const LOCAL_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export function isLocalRequest(req: IncomingMessage): boolean {
  return LOCAL_ADDRS.has(req.socket.remoteAddress || "")
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Compare against self to maintain constant time
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

export function authMiddleware(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  // Local requests always bypass auth
  if (isLocalRequest(req)) return next()

  const config = getConfig()
  // If network access is disabled, reject all remote requests
  if (!config?.networkAccess || !config?.networkPassword) {
    res.statusCode = 403
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Network access is disabled" }))
    return
  }

  // Check Authorization header first, then query param
  const authHeader = req.headers.authorization
  let token: string | null = null
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7)
  } else {
    const url = new URL(req.url || "/", "http://localhost")
    token = url.searchParams.get("token")
  }

  if (!token || !safeCompare(token, config.networkPassword)) {
    res.statusCode = 401
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Authentication required" }))
    return
  }

  next()
}
```

**Step 3: Commit**

```bash
git add server/helpers.ts
git commit -m "feat(network): add auth middleware with constant-time token comparison"
```

---

### Task 3: Add network-info and auth/verify endpoints

**Files:**
- Modify: `server/routes/config.ts`

**Step 1: Add os import at top of file**

```ts
import { networkInterfaces } from "node:os"
```

**Step 2: Add helper to get LAN IP (before the export function)**

```ts
function getLanIp(): string | null {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}
```

**Step 3: Add /api/network-info route inside registerConfigRoutes (before the existing /api/config route)**

```ts
  // GET /api/network-info - return network access status and connection URL
  use("/api/network-info", (req, res, next) => {
    if (req.method !== "GET") return next()
    const config = getConfig()
    if (!config?.networkAccess || !config?.networkPassword) {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ enabled: false }))
      return
    }
    const host = getLanIp()
    const port = (req.socket.address() as { port?: number })?.port || 19384
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({
      enabled: true,
      host,
      port,
      url: host ? `http://${host}:${port}` : null,
    }))
  })

  // POST /api/auth/verify - verify a token is valid (used by login screen)
  use("/api/auth/verify", (req, res, next) => {
    if (req.method !== "POST") return next()
    // If this request reached here, it already passed auth middleware
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ valid: true }))
  })
```

**Step 4: Update the POST /api/config handler to accept new fields**

In the existing POST handler, after `const { claudeDir } = JSON.parse(body)`, change to:

```ts
          const parsed = JSON.parse(body)
          const { claudeDir } = parsed

          // ... existing claudeDir validation ...

          await saveConfig({
            claudeDir: validation.resolved || claudeDir,
            networkAccess: !!parsed.networkAccess,
            networkPassword: parsed.networkPassword || undefined,
          })
```

And update the GET handler to also return network fields:

```ts
      const config = getConfig()
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(config ? {
        claudeDir: config.claudeDir,
        networkAccess: config.networkAccess || false,
        networkPassword: config.networkPassword ? "••••••••" : null,
      } : null))
```

**Step 5: Commit**

```bash
git add server/routes/config.ts
git commit -m "feat(network): add /api/network-info and /api/auth/verify endpoints"
```

---

### Task 4: Wire auth middleware into Electron server

**Files:**
- Modify: `electron/server.ts:67-77` (guard middleware section)

**Step 1: Import authMiddleware**

Add to the imports at top of `electron/server.ts`:

```ts
import { dirs, refreshDirs, cleanupProcesses, authMiddleware } from "../server/helpers"
```

**Step 2: Add auth middleware before the guard middleware (before line 68)**

```ts
  // ── Auth middleware (before all routes) ────────────────────────────
  app.use(authMiddleware)
```

**Step 3: Add token check for WebSocket upgrade**

In the `httpServer.on("upgrade", ...)` handler (line 123), add token validation before handling the PTY upgrade:

```ts
  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname === "/__pty") {
      // Auth check for remote WebSocket connections
      const localAddrs = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
      if (!localAddrs.has(req.socket.remoteAddress || "")) {
        const config = getConfig()
        const token = url.searchParams.get("token")
        if (!config?.networkAccess || !config?.networkPassword || !token || token !== config.networkPassword) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
          socket.destroy()
          return
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      return
    }
    // ... rest of existing dev mode proxy ...
```

**Step 4: Commit**

```bash
git add electron/server.ts
git commit -m "feat(network): wire auth middleware into Electron server and PTY WebSocket"
```

---

### Task 5: Wire auth middleware into Vite dev server

**Files:**
- Modify: `server/api-plugin.ts:27` (guard middleware section)
- Modify: `server/pty-plugin.ts:68-78` (WebSocket upgrade)

**Step 1: Import authMiddleware in api-plugin.ts**

```ts
import { refreshDirs, cleanupProcesses, authMiddleware } from "./helpers"
```

**Step 2: Add auth middleware before the guard middleware in api-plugin.ts (before line 27)**

```ts
      // Auth middleware (before all routes)
      server.middlewares.use(authMiddleware)
```

**Step 3: Add token check in pty-plugin.ts WebSocket upgrade**

Import `getConfig` in pty-plugin.ts and add the same auth check as in electron/server.ts:

```ts
import { getConfig } from "./config"
```

In the upgrade handler:

```ts
      server.httpServer!.on(
        "upgrade",
        (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          const url = new URL(req.url || "/", "http://localhost")
          if (url.pathname !== "/__pty") return

          // Auth check for remote WebSocket connections
          const localAddrs = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
          if (!localAddrs.has(req.socket.remoteAddress || "")) {
            const config = getConfig()
            const token = url.searchParams.get("token")
            if (!config?.networkAccess || !config?.networkPassword || !token || token !== config.networkPassword) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
              socket.destroy()
              return
            }
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req)
          })
        }
      )
```

**Step 4: Commit**

```bash
git add server/api-plugin.ts server/pty-plugin.ts
git commit -m "feat(network): wire auth middleware into Vite dev server and PTY plugin"
```

---

### Task 6: Conditional server binding

**Files:**
- Modify: `electron/main.ts:61-65` (listen port and host logic)

**Step 1: Import getConfig**

```ts
import { createAppServer } from "./server.ts"
```

Already imported. Add:

```ts
import { getConfig } from "../server/config"
```

Wait — the config is loaded inside `createAppServer`. We need access to it after. Since `getConfig()` is a global getter, we can just call it after `createAppServer` returns.

**Step 2: Update the listen logic (lines 61-65)**

```ts
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const config = getConfig()
  const networkEnabled = config?.networkAccess && config?.networkPassword

  const listenHost = networkEnabled ? "0.0.0.0" : "127.0.0.1"
  const listenPort = isDev ? 19384 : (networkEnabled ? 19384 : 0)

  await new Promise<void>((resolve) => {
    httpServer.listen(listenPort, listenHost, () => resolve())
  })
```

**Step 3: Update the console.log to show the correct URL**

```ts
  console.log(`Cogpit server listening on http://${listenHost}:${port}`)
```

**Step 4: Commit**

```bash
git add electron/main.ts
git commit -m "feat(network): conditional 0.0.0.0 binding based on config"
```

---

## Phase 2: Frontend — Auth Layer

### Task 7: Create authFetch utility

**Files:**
- Create: `src/lib/auth.ts`

**Step 1: Create the auth utility module**

```ts
// ── Network auth utilities ──────────────────────────────────────────────

const TOKEN_KEY = "cogpit-network-token"

export function isRemoteClient(): boolean {
  const host = window.location.hostname
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1"
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/**
 * Wrapper around fetch that injects the auth token for remote clients.
 * For local clients, this is a transparent passthrough.
 */
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!isRemoteClient()) return fetch(input, init)

  const token = getToken()
  if (!token) {
    // Trigger re-render to show login screen
    window.dispatchEvent(new Event("cogpit-auth-required"))
    return Promise.reject(new Error("Authentication required"))
  }

  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)

  return fetch(input, { ...init, headers }).then((res) => {
    if (res.status === 401) {
      clearToken()
      window.dispatchEvent(new Event("cogpit-auth-required"))
      return Promise.reject(new Error("Authentication required"))
    }
    return res
  })
}

/**
 * Append auth token to a URL for EventSource (which can't set headers).
 */
export function authUrl(url: string): string {
  if (!isRemoteClient()) return url
  const token = getToken()
  if (!token) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}
```

**Step 2: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat(network): add authFetch and authUrl utilities for remote clients"
```

---

### Task 8: Replace fetch/EventSource calls with auth-aware versions

**Files:**
- Modify: All hooks and components that use `fetch()` or `new EventSource()`

This is a bulk find-and-replace operation. The approach:

1. Add `import { authFetch, authUrl } from "@/lib/auth"` to each file
2. Replace `fetch(` with `authFetch(` for API calls
3. Replace `new EventSource(url)` with `new EventSource(authUrl(url))`

**Files to modify (exhaustive list):**

| File | Changes |
|------|---------|
| `src/App.tsx` | 1 `fetch` → `authFetch` |
| `src/hooks/useAppConfig.ts` | 2 `fetch` → `authFetch` |
| `src/hooks/useConfigValidation.ts` | 2 `fetch` → `authFetch` |
| `src/hooks/useKillAll.ts` | 1 `fetch` → `authFetch` |
| `src/hooks/useLiveSession.ts` | 1 `EventSource` → `authUrl` |
| `src/hooks/useNewSession.ts` | 2 `fetch` → `authFetch` |
| `src/hooks/usePtyChat.ts` | 3 `fetch` → `authFetch` |
| `src/hooks/useSessionActions.ts` | 4 `fetch` → `authFetch` |
| `src/hooks/useSessionTeam.ts` | 1 `fetch` → `authFetch` |
| `src/hooks/useTeamLive.ts` | 1 `EventSource` → `authUrl` |
| `src/hooks/useUndoRedo.ts` | 7 `fetch` → `authFetch` |
| `src/hooks/useUrlSync.ts` | 1 `fetch` → `authFetch` |
| `src/components/Dashboard.tsx` | 5 `fetch` → `authFetch` |
| `src/components/FileChangesPanel.tsx` | 1 `fetch` → `authFetch` |
| `src/components/LiveSessions.tsx` | 3 `fetch` → `authFetch` |
| `src/components/ServerPanel.tsx` | 1 `EventSource` → `authUrl` |
| `src/components/SessionBrowser.tsx` | 4 `fetch` → `authFetch` |
| `src/components/StatsPanel.tsx` | 3 `fetch` → `authFetch` |
| `src/components/TeamsDashboard.tsx` | 2 `fetch` → `authFetch` |
| `src/components/TeamsList.tsx` | 1 `fetch` → `authFetch` |
| `src/components/teams/TeamChatInput.tsx` | 1 `fetch` → `authFetch` |

**Step 1:** For each file above, add the import and do the replacement. Work through them in batches.

**Step 2: Commit**

```bash
git add src/
git commit -m "feat(network): replace fetch/EventSource with auth-aware wrappers"
```

---

### Task 9: Create LoginScreen component

**Files:**
- Create: `src/components/LoginScreen.tsx`

**Step 1: Create the login screen**

```tsx
import { useState, useCallback } from "react"
import { Eye, EyeOff, Lock, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { setToken } from "@/lib/auth"

interface LoginScreenProps {
  onAuthenticated: () => void
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) return

    setLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${password}`,
          "Content-Type": "application/json",
        },
      })

      if (res.ok) {
        setToken(password)
        onAuthenticated()
      } else {
        setError("Invalid password")
      }
    } catch {
      setError("Failed to connect to server")
    } finally {
      setLoading(false)
    }
  }, [password, onAuthenticated])

  return (
    <div className="dark flex h-dvh items-center justify-center bg-zinc-950">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 px-6">
        <div className="flex flex-col items-center gap-3 mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500/10 border border-blue-500/20">
            <Lock className="size-5 text-blue-400" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold text-zinc-100">Cogpit</h1>
            <p className="text-sm text-zinc-500">Enter the password to connect</p>
          </div>
        </div>

        <div className="relative">
          <Input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="pr-10 bg-zinc-900 border-zinc-700 focus:border-zinc-600"
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-400">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={loading || !password.trim()}>
          {loading ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
          Connect
        </Button>
      </form>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add src/components/LoginScreen.tsx
git commit -m "feat(network): add LoginScreen component for remote authentication"
```

---

### Task 10: Create useNetworkAuth hook

**Files:**
- Create: `src/hooks/useNetworkAuth.ts`

**Step 1: Create the hook**

```ts
import { useState, useEffect, useCallback } from "react"
import { isRemoteClient, getToken, clearToken } from "@/lib/auth"

export function useNetworkAuth() {
  const remote = isRemoteClient()
  const [authenticated, setAuthenticated] = useState(!remote || !!getToken())

  // Listen for auth-required events from authFetch
  useEffect(() => {
    if (!remote) return

    const handler = () => setAuthenticated(false)
    window.addEventListener("cogpit-auth-required", handler)
    return () => window.removeEventListener("cogpit-auth-required", handler)
  }, [remote])

  const handleAuthenticated = useCallback(() => {
    setAuthenticated(true)
  }, [])

  const logout = useCallback(() => {
    clearToken()
    setAuthenticated(false)
  }, [])

  return {
    /** Whether this is a remote client (not localhost) */
    isRemote: remote,
    /** Whether the client is authenticated (always true for local) */
    authenticated,
    /** Call when login succeeds */
    handleAuthenticated,
    /** Clear token and show login screen */
    logout,
  }
}
```

**Step 2: Commit**

```bash
git add src/hooks/useNetworkAuth.ts
git commit -m "feat(network): add useNetworkAuth hook"
```

---

## Phase 3: Frontend — UI Integration

### Task 11: Integrate auth gate into App.tsx

**Files:**
- Modify: `src/App.tsx`

**Step 1: Add imports**

```ts
import { LoginScreen } from "@/components/LoginScreen"
import { useNetworkAuth } from "@/hooks/useNetworkAuth"
```

**Step 2: Add the hook call at the top of the App component (after existing hooks)**

```ts
  const networkAuth = useNetworkAuth()
```

**Step 3: Add the auth gate before the config gate (before line 241)**

```ts
  // ─── AUTH GATE (remote clients only) ──────────────────────────────────────
  if (!networkAuth.authenticated) {
    return <LoginScreen onAuthenticated={networkAuth.handleAuthenticated} />
  }
```

**Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(network): integrate login gate for remote clients"
```

---

### Task 12: Add network URL to useAppConfig

**Files:**
- Modify: `src/hooks/useAppConfig.ts`

**Step 1: Add networkUrl state**

```ts
  const [networkUrl, setNetworkUrl] = useState<string | null>(null)
```

**Step 2: Fetch network info on mount (add a useEffect after the existing config fetch)**

```ts
  useEffect(() => {
    authFetch("/api/network-info")
      .then((res) => res.json())
      .then((data: { enabled: boolean; url?: string }) => {
        setNetworkUrl(data.enabled && data.url ? data.url : null)
      })
      .catch(() => setNetworkUrl(null))
  }, [claudeDir]) // Re-fetch when config changes
```

**Step 3: Add to return value**

```ts
  return {
    // ... existing fields ...
    networkUrl,
  }
```

**Step 4: Commit**

```bash
git add src/hooks/useAppConfig.ts
git commit -m "feat(network): fetch and expose networkUrl from useAppConfig"
```

---

### Task 13: Show connection URL in DesktopHeader

**Files:**
- Modify: `src/components/DesktopHeader.tsx`

**Step 1: Add `networkUrl` to props interface (line 22)**

```ts
interface DesktopHeaderProps {
  session: ParsedSession | null
  isLive: boolean
  showSidebar: boolean
  showStats: boolean
  killing: boolean
  networkUrl: string | null
  onGoHome: () => void
  onToggleSidebar: () => void
  onToggleStats: () => void
  onKillAll: () => void
  onOpenSettings: () => void
}
```

**Step 2: Destructure in component (add `networkUrl` to destructuring)**

**Step 3: Add copy state for URL**

```ts
  const [urlCopied, setUrlCopied] = useState(false)

  const copyNetworkUrl = useCallback(() => {
    if (!networkUrl) return
    navigator.clipboard.writeText(networkUrl)
    setUrlCopied(true)
    setTimeout(() => setUrlCopied(false), 1500)
  }, [networkUrl])
```

**Step 4: Add the URL chip in the header, between `<div className="flex-1" />` and the toolbar buttons (after line 129)**

Add `Globe` to the lucide imports, then:

```tsx
      {networkUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={copyNetworkUrl}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-mono text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50 transition-colors"
            >
              <Globe className="size-3 text-green-500" />
              {urlCopied ? (
                <span className="text-green-400">Copied!</span>
              ) : (
                networkUrl
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>Click to copy connection URL</TooltipContent>
        </Tooltip>
      )}
```

**Step 5: Update the App.tsx DesktopHeader usage to pass networkUrl**

In `App.tsx` line 502:

```tsx
      <DesktopHeader
        session={state.session}
        isLive={isLive}
        showSidebar={showSidebar}
        showStats={showStats}
        killing={killing}
        networkUrl={config.networkUrl}
        onGoHome={actions.handleGoHome}
        onToggleSidebar={handleToggleSidebar}
        onToggleStats={() => setShowStats(!showStats)}
        onKillAll={handleKillAll}
        onOpenSettings={config.openConfigDialog}
      />
```

**Step 6: Commit**

```bash
git add src/components/DesktopHeader.tsx src/App.tsx
git commit -m "feat(network): show connection URL in desktop header"
```

---

### Task 14: Show connection URL in MobileHeader

**Files:**
- Modify: `src/components/MobileHeader.tsx`

**Step 1: Add `networkUrl` to props and destructure**

**Step 2: Add URL display in the left section, after the session slug / Cogpit title**

Add a small monospace URL below the title or as a badge when network is active:

```tsx
        {networkUrl && !session && (
          <span className="text-[10px] font-mono text-zinc-600 truncate">
            {networkUrl}
          </span>
        )}
```

**Step 3: Update App.tsx MobileHeader usage to pass networkUrl**

```tsx
        <MobileHeader
          session={state.session}
          sessionSource={state.sessionSource}
          isLive={isLive}
          killing={killing}
          creatingSession={creatingSession}
          networkUrl={config.networkUrl}
          onGoHome={actions.handleGoHome}
          onKillAll={handleKillAll}
          onOpenSettings={config.openConfigDialog}
          onNewSession={handleNewSession}
        />
```

**Step 4: Commit**

```bash
git add src/components/MobileHeader.tsx src/App.tsx
git commit -m "feat(network): show connection URL in mobile header"
```

---

### Task 15: Add network access settings to ConfigDialog

**Files:**
- Modify: `src/components/ConfigDialog.tsx`
- Modify: `src/hooks/useConfigValidation.ts` (update save to include network fields)

**Step 1: Extend ConfigDialog state**

Add state for network fields:

```ts
  const [networkAccess, setNetworkAccess] = useState(false)
  const [networkPassword, setNetworkPassword] = useState("")
  const [showNetworkPassword, setShowNetworkPassword] = useState(false)
```

**Step 2: Load network settings when dialog opens**

In the existing `useEffect` that resets on open, fetch current network config:

```ts
  useEffect(() => {
    if (open) {
      setPath(currentPath)
      reset()
      // Fetch current network settings
      authFetch("/api/config")
        .then((res) => res.json())
        .then((data) => {
          setNetworkAccess(data?.networkAccess || false)
          setNetworkPassword("") // Don't pre-fill password for security
        })
        .catch(() => {})
    }
  }, [open, currentPath, reset])
```

**Step 3: Update handleSave to include network fields**

```ts
  const handleSave = useCallback(async () => {
    setSaving(true)
    const result = await save(path, { networkAccess, networkPassword: networkAccess ? networkPassword : undefined })
    if (result.success && result.claudeDir) {
      onSaved(result.claudeDir)
    }
    setSaving(false)
  }, [path, networkAccess, networkPassword, save, onSaved])
```

**Step 4: Add network settings UI section after the path input section**

Add `Eye`, `EyeOff`, `Globe`, `Wifi`, `WifiOff` to lucide imports:

```tsx
        {/* Network Access */}
        <div className="space-y-3 pt-3 border-t border-zinc-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {networkAccess ? (
                <Wifi className="size-4 text-green-400" />
              ) : (
                <WifiOff className="size-4 text-zinc-500" />
              )}
              <div>
                <p className="text-sm font-medium text-zinc-200">Network Access</p>
                <p className="text-xs text-zinc-500">Allow other devices to connect</p>
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={networkAccess}
              onClick={() => setNetworkAccess(!networkAccess)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                networkAccess ? "bg-green-600" : "bg-zinc-700"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  networkAccess ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {networkAccess && (
            <div className="space-y-2">
              <label className="text-xs text-zinc-400">Password</label>
              <div className="relative">
                <Input
                  type={showNetworkPassword ? "text" : "password"}
                  value={networkPassword}
                  onChange={(e) => setNetworkPassword(e.target.value)}
                  placeholder="Set a password for remote access"
                  className="pr-10 bg-zinc-950 border-zinc-700 focus:border-zinc-600"
                />
                <button
                  type="button"
                  onClick={() => setShowNetworkPassword(!showNetworkPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  {showNetworkPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-zinc-600">
                Requires app restart to take effect. Port: 19384
              </p>
            </div>
          )}
        </div>
```

**Step 5: Update useConfigValidation.ts save function to accept network fields**

Modify the `save` function signature and POST body to include network fields.

**Step 6: Commit**

```bash
git add src/components/ConfigDialog.tsx src/hooks/useConfigValidation.ts
git commit -m "feat(network): add network access toggle and password to settings"
```

---

## Phase 4: Final Wiring

### Task 16: Build and smoke test

**Step 1: Run typecheck**

```bash
bun run typecheck
```

Fix any type errors.

**Step 2: Run lint**

```bash
bun run lint
```

Fix any lint issues.

**Step 3: Run dev server**

```bash
bun run dev
```

Verify:
- App loads normally on localhost (no login screen)
- Settings dialog shows network access toggle
- Toggle on, set password, save
- Check that `/api/network-info` returns `{ enabled: false }` (server hasn't restarted)

**Step 4: Test with Electron**

```bash
bun run electron:dev
```

Verify:
- Enable network access in settings with a password
- Restart the app
- Connection URL appears in header
- Can access from another device on LAN using the URL
- Other device sees login screen
- After entering password, full app works

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat(network): complete network access feature with auth and UI"
```
