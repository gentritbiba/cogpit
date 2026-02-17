# PTY-Based Interactive Chat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the one-shot `claude -p` message sending with a persistent PTY-backed interactive Claude process, so users can send messages mid-stream exactly like the terminal interface.

**Architecture:** When the user first sends a message to a session, we spawn a persistent `claude --resume <sessionId>` process via the existing PTY infrastructure (WebSocket + node-pty). Subsequent messages pipe through stdin to that living process. The JSONL file watcher continues providing structured conversation updates unchanged. The input is always enabled — no more disabled-while-sending state.

**Tech Stack:** React 19, node-pty (already installed), WebSocket (existing `/__pty` endpoint), Vite plugin architecture.

---

### Task 1: Create `usePtyChat` Hook — Core PTY Chat Logic

This replaces `useClaudeChat`. Instead of REST calls to `/api/send-message`, it uses the existing `useTerminalManager` to spawn and communicate with a persistent `claude` process.

**Files:**
- Create: `src/hooks/usePtyChat.ts`
- Reference: `src/hooks/useTerminalManager.ts` (lines 1-208, the full PTY WebSocket manager)
- Reference: `src/hooks/useClaudeChat.ts` (lines 1-71, the current REST-based hook we're replacing)

**Step 1: Write the hook**

```typescript
import { useState, useCallback, useRef, useEffect } from "react"
import type { TerminalManager } from "@/hooks/useTerminalManager"
import type { SessionSource } from "@/hooks/useLiveSession"

export type PtyChatStatus = "idle" | "connected" | "error"

interface UsePtyChatOpts {
  terminalManager: TerminalManager
  sessionSource: SessionSource | null
  cwd?: string
}

export function usePtyChat({ terminalManager, sessionSource, cwd }: UsePtyChatOpts) {
  const [status, setStatus] = useState<PtyChatStatus>("idle")
  const [error, setError] = useState<string | undefined>()
  const [pendingMessage, setPendingMessage] = useState<string | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  // Derive sessionId from fileName
  const sessionId = sessionSource?.fileName?.replace(".jsonl", "") ?? null

  // When session changes, disconnect any existing PTY
  useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      if (ptyIdRef.current) {
        terminalManager.kill(ptyIdRef.current)
        cleanupRef.current?.()
        cleanupRef.current = null
        ptyIdRef.current = null
      }
      sessionIdRef.current = sessionId
      setStatus("idle")
      setError(undefined)
      setPendingMessage(null)
    }
  }, [sessionId, terminalManager])

  // Watch for PTY session exit to update status
  useEffect(() => {
    const ptyId = ptyIdRef.current
    if (!ptyId) return

    const unsub = terminalManager.onExit(ptyId, (_code) => {
      ptyIdRef.current = null
      cleanupRef.current?.()
      cleanupRef.current = null
      setStatus("idle")
      setPendingMessage(null)
    })

    cleanupRef.current = unsub
    return unsub
  }, [status, terminalManager])

  const sendMessage = useCallback(
    (text: string) => {
      if (!sessionId) return

      setPendingMessage(text)

      if (!ptyIdRef.current) {
        // First message: spawn a persistent interactive claude process
        const cleanEnvArgs: string[] = []

        const ptyId = terminalManager.spawn({
          name: `claude-${sessionId.slice(0, 8)}`,
          cwd: cwd || undefined,
          command: "claude",
          args: ["--resume", sessionId, "--dangerously-skip-permissions"],
          cols: 120,
          rows: 40,
        })

        ptyIdRef.current = ptyId
        setStatus("connected")

        // Wait a brief moment for Claude TUI to initialize, then send the message
        setTimeout(() => {
          if (ptyIdRef.current === ptyId) {
            terminalManager.sendInput(ptyId, text + "\n")
          }
        }, 500)
      } else {
        // PTY already running — pipe message directly to stdin
        terminalManager.sendInput(ptyIdRef.current, text + "\n")
      }
    },
    [sessionId, cwd, terminalManager]
  )

  const interrupt = useCallback(() => {
    if (ptyIdRef.current) {
      // Send Escape key to interrupt Claude mid-stream (like pressing Esc in terminal)
      terminalManager.sendInput(ptyIdRef.current, "\x1b")
    }
  }, [terminalManager])

  const stopAgent = useCallback(() => {
    if (ptyIdRef.current) {
      terminalManager.kill(ptyIdRef.current)
      ptyIdRef.current = null
      cleanupRef.current?.()
      cleanupRef.current = null
      setStatus("idle")
      setPendingMessage(null)
    }
  }, [terminalManager])

  const clearPending = useCallback(() => {
    setPendingMessage(null)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (ptyIdRef.current) {
        terminalManager.kill(ptyIdRef.current)
      }
    }
  }, [terminalManager])

  return {
    status,
    error,
    pendingMessage,
    sendMessage,
    interrupt,
    stopAgent,
    clearPending,
    isConnected: status === "connected",
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | head -30`
Expected: No errors from `usePtyChat.ts` (it won't be imported yet, but should have no syntax errors)

**Step 3: Commit**

```bash
git add src/hooks/usePtyChat.ts
git commit -m "feat: add usePtyChat hook for persistent PTY-backed Claude sessions"
```

---

### Task 2: Update `ChatInput` — Always-Enabled Input with Interrupt Button

The input must never be disabled. The stop button sends Escape (interrupt) instead of killing the process. Add a separate "Disconnect" action for fully killing the PTY.

**Files:**
- Modify: `src/components/ChatInput.tsx` (entire file, 111 lines)

**Step 1: Update ChatInput to support new status model**

Replace the entire `ChatInput.tsx` with:

```typescript
import { useState, useRef, useCallback } from "react"
import { Send, Square, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type ChatStatus = "ready" | "sending" | "error" | "idle" | "connected"

interface ChatInputProps {
  status: ChatStatus
  error?: string
  isConnected?: boolean
  onSend: (message: string) => void
  onStop?: () => void
  onInterrupt?: () => void
  onDisconnect?: () => void
}

export function ChatInput({
  status,
  error,
  isConnected,
  onSend,
  onStop,
  onInterrupt,
  onDisconnect,
}: ChatInputProps) {
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText("")
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
    }
  }, [text, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && isConnected && onInterrupt) {
        e.preventDefault()
        onInterrupt()
        return
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit, isConnected, onInterrupt]
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value)
      const el = e.target
      el.style.height = "auto"
      el.style.height = Math.min(el.scrollHeight, 200) + "px"
    },
    []
  )

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80 px-3 py-2">
      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={
              isConnected
                ? "Send a message... (Enter to send, Esc to interrupt)"
                : "Send a message to this session... (Enter to send)"
            }
            rows={1}
            className={cn(
              "w-full resize-none rounded-lg border bg-zinc-950 px-3 py-2 text-sm text-zinc-100",
              "placeholder:text-zinc-600 focus:outline-none focus:ring-1",
              "border-zinc-700 focus:ring-blue-500/40"
            )}
          />
          {isConnected && (
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
            </div>
          )}
        </div>

        {/* Interrupt button — sends Escape to Claude */}
        {isConnected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
                onClick={onInterrupt}
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Interrupt agent (Esc)</TooltipContent>
          </Tooltip>
        )}

        {/* Disconnect button — kills the PTY process entirely */}
        {isConnected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
                onClick={onDisconnect}
              >
                <Unplug className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Disconnect session</TooltipContent>
          </Tooltip>
        )}

        {/* Send button */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          disabled={!text.trim()}
          onClick={handleSubmit}
        >
          <Send className="size-4" />
        </Button>
      </div>
      {status === "error" && error && (
        <p className="mt-1 text-[10px] text-red-400">{error}</p>
      )}
    </div>
  )
}
```

Key changes from original:
- **Input is never disabled** — no `disabled={status === "sending"}`, always typeable
- **Escape key** in textarea calls `onInterrupt` (sends `\x1b` to PTY)
- **Interrupt button** (amber square) sends Escape to Claude — like pressing Esc in terminal
- **Disconnect button** (red unplug icon) kills the PTY process entirely
- **Send button** always visible, only disabled when text is empty
- **Green dot indicator** when connected to a PTY session
- **Placeholder text** changes based on connection state

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | head -30`
Expected: May have type warnings since App.tsx still uses old props — that's fine, we fix it in Task 3.

**Step 3: Commit**

```bash
git add src/components/ChatInput.tsx
git commit -m "feat: update ChatInput to always-enabled with interrupt and disconnect"
```

---

### Task 3: Wire Up `App.tsx` — Switch from REST Chat to PTY Chat

Replace `useClaudeChat` with `usePtyChat` in `App.tsx`, pass the terminal manager through, and update the ChatInput props.

**Files:**
- Modify: `src/App.tsx` (lines 30-33 imports, line 92-95 hook usage, lines 512-526 pending UI, lines 576-585 ChatInput)

**Step 1: Update imports** (line 32-33)

Replace:
```typescript
import { useClaudeChat } from "@/hooks/useClaudeChat"
```
With:
```typescript
import { usePtyChat } from "@/hooks/usePtyChat"
import { useTerminalManager } from "@/hooks/useTerminalManager"
```

**Step 2: Initialize terminal manager and switch hook** (around lines 90-96)

Replace:
```typescript
  // Claude chat (send messages to session via HTTP)
  const claudeChat = useClaudeChat({
    sessionSource,
    cwd: session?.cwd,
  })
```
With:
```typescript
  // Terminal manager for PTY-backed Claude sessions
  const terminalManager = useTerminalManager()

  // Claude chat (send messages to session via persistent PTY)
  const claudeChat = usePtyChat({
    terminalManager,
    sessionSource,
    cwd: session?.cwd,
  })
```

**Step 3: Update the pending message / working indicator** (lines 512-526)

Replace:
```typescript
                    {claudeChat.status === "sending" && (
                      <div className="mx-4 mt-4 space-y-3">
                        {claudeChat.pendingMessage && (
                          <div className="flex justify-end">
                            <div className="max-w-[80%] rounded-lg bg-blue-600/20 border border-blue-500/20 px-3 py-2 text-sm text-zinc-200">
                              {claudeChat.pendingMessage}
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-2 text-zinc-500">
                          <Loader2 className="size-3.5 animate-spin text-blue-400" />
                          <span className="text-xs">Agent is working...</span>
                        </div>
                      </div>
                    )}
```
With:
```typescript
                    {claudeChat.pendingMessage && (
                      <div className="mx-4 mt-4 space-y-3">
                        <div className="flex justify-end">
                          <div className="max-w-[80%] rounded-lg bg-blue-600/20 border border-blue-500/20 px-3 py-2 text-sm text-zinc-200">
                            {claudeChat.pendingMessage}
                          </div>
                        </div>
                        {claudeChat.isConnected && (
                          <div className="flex items-center gap-2 text-zinc-500">
                            <Loader2 className="size-3.5 animate-spin text-blue-400" />
                            <span className="text-xs">Agent is working...</span>
                          </div>
                        )}
                      </div>
                    )}
```

**Step 4: Update ChatInput props** (lines 576-585)

Replace:
```typescript
        <ChatInput
          status={claudeChat.status}
          error={claudeChat.error}
          onSend={claudeChat.sendMessage}
          onStop={claudeChat.stopAgent}
        />
```
With:
```typescript
        <ChatInput
          status={claudeChat.status}
          error={claudeChat.error}
          isConnected={claudeChat.isConnected}
          onSend={claudeChat.sendMessage}
          onInterrupt={claudeChat.interrupt}
          onDisconnect={claudeChat.stopAgent}
        />
```

**Step 5: Remove unused `Loader2` import if no longer needed**

Check if `Loader2` is still used elsewhere in App.tsx. It is — it's used in the pending message section we kept. So keep the import.

**Step 6: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | head -30`
Expected: Clean build, no errors.

**Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire App to use PTY-backed chat instead of REST one-shot"
```

---

### Task 4: Clear Pending Message When Real Turn Arrives

The existing auto-scroll logic in `App.tsx` calls `claudeChat.clearPending()` when new turns arrive (line 121). This already works because `usePtyChat` exposes the same `clearPending` method. But we need to verify the turn-count logic still functions correctly since pending messages now show independently of status.

**Files:**
- Modify: `src/App.tsx` (lines 116-131, the turn-count effect)

**Step 1: Verify the existing logic**

The current code at lines 116-131:
```typescript
  const turnCount = session?.turns.length ?? 0
  useEffect(() => {
    if (turnCount === 0) return
    if (turnCount > prevTurnCountRef.current) {
      if (claudeChat.pendingMessage) {
        claudeChat.clearPending()
      }
      ...
    }
    prevTurnCountRef.current = turnCount
  }, [turnCount, claudeChat])
```

This already clears the pending message when a new turn is detected via JSONL. Since `usePtyChat.clearPending()` works identically, no changes needed here. Just verify during manual testing.

**Step 2: Run the app and test manually**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run dev`

Test scenario:
1. Open a session in the browser
2. Type a message and send it — verify PTY spawns (green dot appears)
3. While Claude is working, type another message and press Enter — verify it's injected mid-stream
4. Press Escape in the textarea — verify Claude gets interrupted
5. Send another message after interrupt — verify it goes through the same PTY
6. Click Disconnect — verify PTY dies and green dot disappears
7. Send a new message — verify a fresh PTY spawns

**Step 3: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: adjust pending message clearing for PTY chat flow"
```

---

### Task 5: Handle PTY Startup Timing

The 500ms `setTimeout` in `usePtyChat` for the initial message is a rough heuristic. Claude's TUI may take variable time to initialize. We should listen for PTY output to detect when Claude is ready before sending the first message.

**Files:**
- Modify: `src/hooks/usePtyChat.ts` (the `sendMessage` function, around the `setTimeout` call)

**Step 1: Replace setTimeout with output-based readiness detection**

In `usePtyChat.ts`, update the `sendMessage` callback. Instead of a blind 500ms timeout, subscribe to PTY output and wait for Claude's prompt indicator (the TUI renders a `>` or similar prompt when ready):

```typescript
      if (!ptyIdRef.current) {
        const ptyId = terminalManager.spawn({
          name: `claude-${sessionId.slice(0, 8)}`,
          cwd: cwd || undefined,
          command: "claude",
          args: ["--resume", sessionId, "--dangerously-skip-permissions"],
          cols: 120,
          rows: 40,
        })

        ptyIdRef.current = ptyId
        setStatus("connected")

        // Wait for Claude TUI to be ready, then send the message
        let sent = false
        const unsub = terminalManager.onOutput(ptyId, (data) => {
          // Claude TUI is ready when we see output (prompt rendered)
          if (!sent) {
            sent = true
            // Small delay to let the TUI fully render after first output
            setTimeout(() => {
              if (ptyIdRef.current === ptyId) {
                terminalManager.sendInput(ptyId, text + "\n")
              }
            }, 200)
            unsub()
          }
        })

        // Fallback: if no output within 3s, send anyway
        setTimeout(() => {
          if (!sent) {
            sent = true
            if (ptyIdRef.current === ptyId) {
              terminalManager.sendInput(ptyId, text + "\n")
            }
            unsub()
          }
        }, 3000)
      }
```

**Step 2: Verify it compiles**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | head -30`
Expected: Clean build.

**Step 3: Test manually**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run dev`

Test: Send a first message to a session. Verify the message gets delivered (check JSONL watcher picks up the new turn). Try with both fast and slow network conditions.

**Step 4: Commit**

```bash
git add src/hooks/usePtyChat.ts
git commit -m "feat: detect Claude TUI readiness before sending first message"
```

---

### Task 6: Clean Up Old REST Chat Code

Now that PTY chat is working, remove the unused REST-based chat infrastructure.

**Files:**
- Delete: `src/hooks/useClaudeChat.ts`
- Modify: `server/api-plugin.ts` (lines 862-938 `/api/send-message`, lines 940-980 `/api/stop-session`) — remove or mark deprecated

**Step 1: Delete the old hook**

```bash
rm src/hooks/useClaudeChat.ts
```

**Step 2: Verify no other imports reference it**

Run: `grep -r "useClaudeChat" src/`
Expected: No results (App.tsx was already updated in Task 3).

**Step 3: Keep the REST endpoints for now**

The `/api/send-message` and `/api/stop-session` endpoints in `api-plugin.ts` can stay as-is. They don't hurt anything and could serve as a fallback. Don't delete server code that might be useful.

**Step 4: Verify build**

Run: `cd /Users/gentritbiba/.claude/cogpit && bun run build 2>&1 | head -30`
Expected: Clean build, no missing import errors.

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove unused useClaudeChat hook (replaced by usePtyChat)"
```

---

## Notes

- **JSONL watcher is untouched** — `useLiveSession` + SSE `/api/watch` continue providing structured conversation updates. The PTY is only for input, not for parsing output.
- **The PTY plugin already exists** — `server/pty-plugin.ts` and `useTerminalManager.ts` are production-ready with WebSocket reconnection, scrollback buffering, and multi-client support. We just wire into them.
- **`--dangerously-skip-permissions`** is carried over from the original implementation. The user already opted into this for the cogpit use case.
- **The `Unplug` icon** from lucide-react is already available in the project's lucide dependency. No new packages needed.
