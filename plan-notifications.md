# Plan: isLive Fix + Agent Completion Notifications

## Overview

Two related changes:
1. **Fix isLive state loss** — Server sends `recentlyActive` in SSE init so reconnecting to an active session restores `isLive = true`
2. **Add notification system** — Desktop notifications + optional sound when sessions finish, background agents complete, or permission prompts appear. Visual indicator in Live & Recent sidebar.

---

## Phase 1: isLive Fix

### 1.1 Server — Add `recentlyActive` to SSE init

**File:** `server/routes/files-watch.ts`
**Lines:** 216-219

The current code:
```ts
stat(filePath)
  .then((s) => {
    offset = s.size
    res.write(`data: ${JSON.stringify({ type: "init", offset })}\n\n`)
  })
```

**Change:** After getting the stat, check if the file was modified within the last 30 seconds. Include that in the init payload:

```ts
stat(filePath)
  .then((s) => {
    offset = s.size
    const recentlyActive = Date.now() - s.mtimeMs < 30_000
    res.write(`data: ${JSON.stringify({ type: "init", offset, recentlyActive })}\n\n`)
  })
```

**Verification:** Run `bun run test` — no server tests cover this SSE route directly, but confirm no regressions.

### 1.2 Client — Handle `recentlyActive` in useLiveSession

**File:** `src/hooks/useLiveSession.ts`
**Lines:** 79-80

The current code:
```ts
if (data.type === "init") {
  resetStaleTimer()
}
```

**Change:** If the init message includes `recentlyActive: true`, set `isLive(true)`:

```ts
if (data.type === "init") {
  if (data.recentlyActive) {
    setIsLive(true)
  }
  resetStaleTimer()
}
```

This means reconnecting to a session that was written to in the last 30s will immediately show as live, then the 30s stale timer takes over normally.

### 1.3 Update useLiveSession tests

**File:** `src/hooks/__tests__/useLiveSession.test.ts`

Add two tests:

1. **"sets isLive=true when init has recentlyActive"** — Send `{ type: "init", recentlyActive: true }`, verify `isLive` is `true`.
2. **"does not set isLive on init without recentlyActive"** — Send `{ type: "init" }` (existing behavior), verify `isLive` stays `false`.

**Verification:** `bun run test -- src/hooks/__tests__/useLiveSession.test.ts`

---

## Phase 2: Notification Sound Config Setting

### 2.1 Server — Add `notificationSound` to AppConfig

**File:** `server/config.ts`

Add `notificationSound?: boolean` to the `AppConfig` interface (line 18-23):

```ts
export interface AppConfig {
  claudeDir: string
  networkAccess?: boolean
  networkPassword?: string
  terminalApp?: string
  notificationSound?: boolean
}
```

Update `loadConfig` (line 36-42) to include the new field:

```ts
cachedConfig = {
  claudeDir: parsed.claudeDir,
  networkAccess: !!parsed.networkAccess,
  networkPassword: parsed.networkPassword || undefined,
  terminalApp: parsed.terminalApp || undefined,
  notificationSound: parsed.notificationSound !== false, // default true
}
```

### 2.2 Server — Expose in GET/POST /api/config

**File:** `server/routes/config.ts`

In the GET handler (line 128-133), add `notificationSound`:

```ts
res.end(JSON.stringify(config ? {
  claudeDir: config.claudeDir,
  networkAccess: config.networkAccess || false,
  networkPassword: config.networkPassword ? "set" : null,
  terminalApp: config.terminalApp || null,
  notificationSound: config.notificationSound !== false,
} : null))
```

In the POST handler, around line 190, include in `saveConfig`:

```ts
await saveConfig({
  claudeDir: validation.resolved || claudeDir,
  networkAccess: !!parsed.networkAccess,
  networkPassword: finalPassword,
  terminalApp: parsed.terminalApp || undefined,
  notificationSound: parsed.notificationSound !== false,
})
```

### 2.3 Client — Add toggle to ConfigDialog

**File:** `src/components/ConfigDialog.tsx`

Add state for the setting (after `terminalApp` state, ~line 52):

```ts
const [notificationSound, setNotificationSound] = useState(true)
const [initialNotificationSound, setInitialNotificationSound] = useState(true)
```

In the `useEffect` that fetches config on dialog open (~line 67-89), read the value:

```ts
const notifSound = data?.notificationSound !== false
setNotificationSound(notifSound)
setInitialNotificationSound(notifSound)
```

In `handleSave` (~line 101-113), include it in the save payload:

```ts
const result = await save(path, {
  networkAccess,
  networkPassword: ...,
  terminalApp: ...,
  notificationSound,
})
```

Update `canSave` computation (~line 121) to include:

```ts
const notifChanged = notificationSound !== initialNotificationSound
const canSave = (pathChanged || networkChanged || terminalChanged || notifChanged) && ...
```

Add UI toggle in the dialog body, between Terminal and Network sections. Use the same switch pattern as Network Access:

```tsx
{/* Notification Sound */}
<div className="space-y-2 pt-3 border-t border-border">
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-2">
      {notificationSound ? (
        <Bell className="size-4 text-blue-400" />
      ) : (
        <BellOff className="size-4 text-muted-foreground" />
      )}
      <div>
        <p className="text-sm font-medium text-foreground">Notification Sound</p>
        <p className="text-xs text-muted-foreground">Play sound when agents finish</p>
      </div>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={notificationSound}
      onClick={() => setNotificationSound(!notificationSound)}
      className={`relative inline-flex h-5 w-9 ...`}
    >
      <span className={`... ${notificationSound ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  </div>
</div>
```

Import `Bell, BellOff` from `lucide-react`.

### 2.4 Client — useConfigValidation save function

**File:** `src/hooks/useConfigValidation.ts` (check if `save()` needs updating to pass through extra fields)

Look at how `save()` forwards the extra config fields to `/api/config` POST. It likely already spreads extra options. If not, update to include `notificationSound`.

**Verification:** `bun run test` — check config route tests still pass.

---

## Phase 3: Notification Hook

### 3.1 Create useNotifications hook

**File:** `src/hooks/useNotifications.ts` (new file)

```ts
import { useEffect, useRef } from "react"

interface UseNotificationsOptions {
  /** Current isLive state from useLiveSession */
  isLive: boolean
  /** Current session slug or ID for notification title */
  sessionLabel: string | null
  /** Background agents from StatsPanel polling */
  backgroundAgents: Array<{ agentId: string; isActive: boolean; preview: string }> | null
  /** Pending permission/interaction prompt */
  pendingInteraction: { type: string; toolName?: string } | null
  /** Whether sound is enabled (from config) */
  soundEnabled: boolean
}

export function useNotifications({
  isLive,
  sessionLabel,
  backgroundAgents,
  pendingInteraction,
  soundEnabled,
}: UseNotificationsOptions) {
  const prevIsLiveRef = useRef<boolean | null>(null)
  const prevAgentsRef = useRef<Map<string, boolean>>(new Map())
  const prevPendingRef = useRef<boolean>(false)
  const permissionGrantedRef = useRef(false)

  // Request notification permission on mount
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then((perm) => {
        permissionGrantedRef.current = perm === "granted"
      })
    } else if ("Notification" in window) {
      permissionGrantedRef.current = Notification.permission === "granted"
    }
  }, [])

  // Helper to fire notification + optional sound
  function notify(title: string, body: string) {
    if (!("Notification" in window)) return
    if (Notification.permission !== "granted") return

    new Notification(title, { body, icon: "/icon.png" })

    if (soundEnabled) {
      // Use the Notification API's built-in sound (Electron)
      // or fallback to Audio API
      try {
        const audio = new Audio("/notification.mp3")
        audio.volume = 0.5
        audio.play().catch(() => {})
      } catch {}
    }
  }

  // Watch isLive: true → false = session went idle
  useEffect(() => {
    if (prevIsLiveRef.current === true && !isLive) {
      notify(
        "Session idle",
        sessionLabel ? `"${sessionLabel}" has stopped` : "Session has stopped"
      )
    }
    prevIsLiveRef.current = isLive
  }, [isLive, sessionLabel])

  // Watch background agents: isActive true → false
  useEffect(() => {
    if (!backgroundAgents) return

    const currentMap = new Map(backgroundAgents.map((a) => [a.agentId, a.isActive]))

    for (const [agentId, wasActive] of prevAgentsRef.current) {
      const isNowActive = currentMap.get(agentId)
      if (wasActive && isNowActive === false) {
        const agent = backgroundAgents.find((a) => a.agentId === agentId)
        const preview = agent?.preview?.slice(0, 60) || agentId.slice(0, 8)
        notify("Agent finished", preview)
      }
    }

    prevAgentsRef.current = currentMap
  }, [backgroundAgents])

  // Watch pending interaction (permission prompts)
  useEffect(() => {
    const hasPending = !!pendingInteraction
    if (hasPending && !prevPendingRef.current) {
      const toolName = pendingInteraction?.toolName || "Action"
      notify("Permission required", `${toolName} needs your approval`)
    }
    prevPendingRef.current = hasPending
  }, [pendingInteraction])
}
```

### 3.2 Expose background agents from StatsPanel polling

Currently `BackgroundAgents` in `StatsPanel.tsx` has its own internal state for agents. We need to lift this data up so `useNotifications` can watch it.

**Option:** Create a new hook `useBackgroundAgents.ts` that extracts the polling logic from `BackgroundAgents` component. Then both `StatsPanel` and `App.tsx` can use it.

**File:** `src/hooks/useBackgroundAgents.ts` (new file)

Extract lines 629-657 from `StatsPanel.tsx` (`BackgroundAgents` polling logic) into a hook:

```ts
import { useState, useEffect } from "react"
import { authFetch } from "@/lib/auth"

export interface BgAgent {
  agentId: string
  dirName: string
  fileName: string
  parentSessionId: string
  modifiedAt: number
  isActive: boolean
  preview: string
}

export function useBackgroundAgents(cwd: string | null) {
  const [agents, setAgents] = useState<BgAgent[]>([])

  useEffect(() => {
    if (!cwd) { setAgents([]); return }

    let cancelled = false

    async function fetchAgents() {
      try {
        const res = await authFetch(
          `/api/background-agents?cwd=${encodeURIComponent(cwd!)}`
        )
        if (cancelled) return
        if (res.ok) {
          const data: BgAgent[] = await res.json()
          setAgents(data)
        }
      } catch {}
    }

    fetchAgents()
    const interval = setInterval(fetchAgents, 5_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [cwd])

  return agents
}
```

Then update `BackgroundAgents` component in `StatsPanel.tsx` to accept agents as a prop instead of managing its own polling.

### 3.3 Wire useNotifications into App.tsx

**File:** `src/App.tsx`

Add imports:
```ts
import { useNotifications } from "@/hooks/useNotifications"
import { useBackgroundAgents } from "@/hooks/useBackgroundAgents"
```

Add the hooks (after `useLiveSession`, ~line 135):

```ts
const backgroundAgents = useBackgroundAgents(state.session?.cwd ?? null)

useNotifications({
  isLive,
  sessionLabel: state.session?.slug || state.session?.sessionId?.slice(0, 12) || null,
  backgroundAgents,
  pendingInteraction,
  soundEnabled: notificationSoundEnabled, // from config
})
```

For `notificationSoundEnabled`: fetch from config. Add state:
```ts
const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(true)
```

Fetch on mount (add to the existing config fetch or create a small effect):
```ts
useEffect(() => {
  authFetch("/api/config")
    .then((res) => res.json())
    .then((data) => {
      if (data?.notificationSound !== undefined) {
        setNotificationSoundEnabled(data.notificationSound !== false)
      }
    })
    .catch(() => {})
}, [])
```

Also listen for config changes (when user saves in ConfigDialog):
```ts
// In handleConfigSaved, also update notification sound state
```

### 3.4 Pass backgroundAgents to StatsPanel

Update `StatsPanel` props to accept `backgroundAgents` and pass them to `BackgroundAgents` component instead of it polling internally. This avoids double-polling.

### 3.5 Add notification sound file

**File:** `public/notification.mp3`

Need a short, subtle notification sound. Options:
- Use a tiny base64-encoded sound inline (avoids adding a binary file)
- Or generate a short beep programmatically via Web Audio API

**Recommended:** Use Web Audio API to generate a short tone, avoiding any asset files:

```ts
function playNotificationSound() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 800
    osc.type = "sine"
    gain.gain.value = 0.3
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    osc.start()
    osc.stop(ctx.currentTime + 0.3)
  } catch {}
}
```

This generates a soft 800Hz tone that fades over 0.3s. No file needed.

**Verification:** `bun run test` — new hook needs its own test file.

### 3.6 Test useNotifications

**File:** `src/hooks/__tests__/useNotifications.test.ts` (new file)

Test cases:
1. Requests notification permission on mount
2. Fires notification when `isLive` goes `true → false`
3. Does NOT fire on initial `false` (no false positive on mount)
4. Fires notification when background agent `isActive` goes `true → false`
5. Fires notification when `pendingInteraction` appears
6. Plays sound when `soundEnabled` is `true`
7. Does NOT play sound when `soundEnabled` is `false`
8. Does NOT fire when `Notification.permission` is `"denied"`

Mock `window.Notification` and `AudioContext`.

---

## Phase 4: LiveSessions Visual Indicator

### 4.1 Track session completion events

**File:** `src/components/LiveSessions.tsx`

Add state to track recently-completed session IDs:

```ts
const [recentlyCompleted, setRecentlyCompleted] = useState<Set<string>>(new Set())
const prevActiveRef = useRef<Set<string>>(new Set())
```

In the existing 10s polling effect, after updating `sessions`, compare against previous active set:

```ts
// After setSessions(sessData):
const currentActive = new Set(
  sessData.filter((s: ActiveSessionInfo) => s.isActive).map((s: ActiveSessionInfo) => s.sessionId)
)
const newlyCompleted = new Set<string>()
for (const id of prevActiveRef.current) {
  if (!currentActive.has(id)) {
    newlyCompleted.add(id)
  }
}
if (newlyCompleted.size > 0) {
  setRecentlyCompleted(prev => new Set([...prev, ...newlyCompleted]))
  // Auto-clear after 30s
  setTimeout(() => {
    setRecentlyCompleted(prev => {
      const next = new Set(prev)
      for (const id of newlyCompleted) next.delete(id)
      return next
    })
  }, 30_000)
}
prevActiveRef.current = currentActive
```

### 4.2 Show indicator in session rows

In the session row rendering (~line 287), add a visual indicator for recently-completed sessions. After the green "active" dot, add an alternate state:

```tsx
{hasProcess ? (
  // ... existing green pulsing dot ...
) : recentlyCompleted.has(s.sessionId) ? (
  <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
    <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
  </span>
) : (
  <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground" />
)}
```

The amber pulsing dot indicates "just finished" — it auto-clears after 30 seconds.

**Verification:** `bun run test`, visual check in browser.

---

## Phase 5: Verification

1. `bun run test` — all existing + new tests pass
2. `bun run build` — no type errors
3. Manual test:
   - Open Cogpit, view an active session
   - Navigate away, navigate back → `isLive` should be `true` immediately
   - Wait for session to finish → desktop notification fires
   - Check Live & Recent → amber dot on completed session
   - Open Settings → notification sound toggle works
   - Toggle sound off → notifications still appear but no sound

---

## Files Modified (summary)

| File | Change |
|------|--------|
| `server/routes/files-watch.ts` | Add `recentlyActive` to SSE init |
| `server/config.ts` | Add `notificationSound` to AppConfig |
| `server/routes/config.ts` | Expose `notificationSound` in GET/POST |
| `src/hooks/useLiveSession.ts` | Handle `recentlyActive` in init |
| `src/hooks/__tests__/useLiveSession.test.ts` | Add 2 tests for recentlyActive |
| `src/hooks/useNotifications.ts` | **New** — notification hook |
| `src/hooks/__tests__/useNotifications.test.ts` | **New** — notification tests |
| `src/hooks/useBackgroundAgents.ts` | **New** — extracted from StatsPanel |
| `src/components/StatsPanel.tsx` | Use external agents prop |
| `src/components/ConfigDialog.tsx` | Add notification sound toggle |
| `src/components/LiveSessions.tsx` | Add completion indicator |
| `src/App.tsx` | Wire useNotifications + useBackgroundAgents |
