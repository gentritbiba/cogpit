# Agent Execution & Notification Guide

This guide covers how Cogpit monitors Claude Code agents and where to implement notifications.

## How Agents Are Spawned & Monitored

### 1. Agent Spawning (Claude's Task Tool)

When Claude Code calls the Task tool with `run_in_background: true`:

```json
{
  "type": "tool_use",
  "name": "Task",
  "input": {
    "name": "Background Agent Name",
    "description": "What the agent does",
    "run_in_background": true
  }
}
```

### 2. Task Output

Task output is written to:
```
/private/tmp/claude-{uid}/{projectHash}/tasks/{taskId}.output
```

For background agents, a **symlink** is created pointing to the agent's JSONL file:
```
/private/tmp/claude-{uid}/{projectHash}/tasks/{agentId}.output -> ~/.claude/projects/{project}/{agentId}.jsonl
```

### 3. Agent Progress Tracking

Parent session JSONL includes `agent_progress` messages:
```json
{
  "type": "progress",
  "parentToolUseID": "{taskToolId}",
  "data": {
    "type": "agent_progress",
    "agentId": "{backgroundAgentId}",
    "message": { "type": "user|assistant", ... }
  }
}
```

The parser (`src/lib/parser.ts`) detects `run_in_background: true` and tags corresponding `agent_progress` messages with `isBackground: true`.

---

## API Endpoints for Agent Monitoring

### Get Background Agents

```http
GET /api/background-agents?cwd={projectPath}
```

**Response:**
```json
[
  {
    "agentId": "agent-uuid-123",
    "dirName": "my-project",
    "fileName": "agent-uuid-123.jsonl",
    "parentSessionId": "parent-uuid",
    "modifiedAt": 1708723200000,
    "isActive": true,
    "preview": "First few lines of output..."
  },
  ...
]
```

**Polling interval:** Every 5 seconds (set in `StatsPanel.tsx` line 652)

### Get Background Tasks (Dev Servers, Bash Processes)

```http
GET /api/background-tasks?cwd={projectPath}
```

**Response:**
```json
[
  {
    "id": "task-123",
    "outputPath": "/private/tmp/claude-501/project-hash/tasks/task-123.output",
    "ports": [3000, 5173],
    "portStatus": { "3000": true, "5173": false },
    "preview": "vite listening on ..."
  },
  ...
]
```

**Polling interval:** Every 10 seconds (set in `StatsPanel.tsx` line 475)

### Kill Port

```http
POST /api/kill-port
Content-Type: application/json

{ "port": 3000 }
```

Gracefully terminates the process listening on the port. Falls back to `SIGKILL` if not responsive within 5 seconds.

---

## Data Structures

### SubAgentMessage (with background flag and metadata)

```typescript
interface SubAgentMessage {
  agentId: string
  agentName: string | null              // ← Extracted from Task input.name
  subagentType: string | null           // ← Extracted from Task input.subagent_type
  type: "user" | "assistant"
  content: unknown
  toolCalls: ToolCall[]
  thinking: string[]
  text: string[]
  timestamp: string
  tokenUsage: TokenUsage | null
  model: string | null
  isBackground: boolean  // ← TRUE for background agents
}
```

**Agent metadata extraction:** When a Task tool call creates an agent, the parser captures:
- `agentName` — from `input.name` (e.g., "researcher")
- `subagentType` — from `input.subagent_type` (e.g., "Explore")

These are carried forward to all `SubAgentMessage` objects from that agent. If the Task doesn't specify these fields, they default to `null`. The UI uses these to display human-readable labels instead of cryptic agent IDs.

### TurnContentBlock (separate background_agent block)

```typescript
type TurnContentBlock =
  | { kind: "sub_agent"; messages: SubAgentMessage[] }
  | { kind: "background_agent"; messages: SubAgentMessage[] }  // ← Separate from foreground
  | { kind: "thinking"; blocks: ThinkingBlock[] }
  | { kind: "text"; text: string[] }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }
```

---

## Agent Label Formatting Utilities

Located in `src/components/timeline/agent-utils.ts`, these functions format agent labels for consistent display across UI components.

### `formatAgentLabel(agentId, subagentType?, agentName?)`

Standalone function for formatting agent labels from individual parameters.

**Signature:**
```typescript
function formatAgentLabel(
  agentId: string,
  subagentType?: string | null,
  agentName?: string | null
): string
```

**Returns:** Formatted label following priority:
1. `"{type} - {shortId(8)}"` if `type` (subagentType ?? agentName) is available
2. `"{shortId(8)}"` if no type metadata

**Example outputs:**
```
formatAgentLabel("abc123def456", "Explore", "researcher")
// Returns: "Explore - abc123de"

formatAgentLabel("abc123def456", null, "researcher")
// Returns: "researcher - abc123de"

formatAgentLabel("abc123def456", null, null)
// Returns: "abc123de"
```

**Usage:** Components that have `agentId` + metadata but not a full `SubAgentMessage` object:
- `StatsPanel.tsx` — Formatting agent IDs for background agents display
- `SessionInfoBar.tsx` — Showing agent label when viewing a sub-agent session

### `agentLabel(msg: SubAgentMessage)`

Legacy function that extracts metadata from `SubAgentMessage` and formats the label.

**Signature:**
```typescript
function agentLabel(msg: SubAgentMessage): string
```

**Implementation:** Delegates to `formatAgentLabel(msg.agentId, msg.subagentType, msg.agentName)` (single source of truth).

**Usage:** Components that render `SubAgentMessage` objects directly:
- `BackgroundAgentPanel.tsx` — Timeline display of background agent activity
- `SubAgentPanel.tsx` — Timeline display of foreground sub-agent activity

---

## Current UI Display

### StatsPanel: Background Agents Section

**Location:** `src/components/StatsPanel.tsx` lines 622-680

```typescript
function BackgroundAgents({ cwd, onLoadSession }: ...) {
  const [agents, setAgents] = useState<BgAgent[]>([])

  useEffect(() => {
    // Poll /api/background-agents every 5 seconds
    const interval = setInterval(fetchAgents, 5_000)
    return () => clearInterval(interval)
  }, [cwd])

  return (
    <section>
      {agents.map(agent => (
        <div key={agent.agentId}>
          <button onClick={() => onLoadSession?.(agent.dirName, agent.fileName)}>
            {agent.agentId}
          </button>
          <span className={agent.isActive ? "text-green-400" : "text-muted-foreground"}>
            {agent.isActive ? "Running" : "Done"}
          </span>
        </div>
      ))}
    </section>
  )
}
```

**Features:**
- Displays agent ID, active status, last update time
- Click to load agent session in main view
- Color-coded agent badges (indigo, cyan, amber, rose, emerald)
- Polls every 5 seconds for updates

### Timeline: Background Agent Panel

**Location:** `src/components/timeline/BackgroundAgentPanel.tsx`

Renders background agent messages with:
- Violet color scheme (border, icons, text)
- Expandable turns
- Tool call breakdown
- Token usage stats

---

## Where to Add Notifications

### 1. Agent Completion

When `isActive` changes from `true` to `false` in `BackgroundAgents` component:

```typescript
const [prevActiveStates, setPrevActiveStates] = useState<Record<string, boolean>>({})

useEffect(() => {
  const newStates = agents.reduce((acc, a) => ({ ...acc, [a.agentId]: a.isActive }), {})

  // Detect transitions from running → done
  agents.forEach(agent => {
    if (prevActiveStates[agent.agentId] && !agent.isActive) {
      // Agent just completed!
      showNotification(`Background agent "${agent.agentId}" completed`)
    }
  })

  setPrevActiveStates(newStates)
}, [agents])
```

### 2. Server Coming Online

When a port transitions from `false` to `true` in `BackgroundServers` component:

```typescript
useEffect(() => {
  tasks.forEach(task => {
    task.ports.forEach(port => {
      if (prevPortStatus[port] !== task.portStatus[port] && task.portStatus[port]) {
        // Port just came online
        showNotification(`Server listening on port ${port}`)
      }
    })
  })
}, [tasks])
```

### 3. Error Detection

Monitor agent output for error patterns:

```typescript
function BackgroundAgents({ ... }) {
  const [lastPreviews, setLastPreviews] = useState<Record<string, string>>({})

  useEffect(() => {
    agents.forEach(agent => {
      const newPreview = agent.preview
      const oldPreview = lastPreviews[agent.agentId] || ""

      if (newPreview && !oldPreview) {
        // New output appeared
        if (newPreview.includes("error") || newPreview.includes("Error")) {
          showNotification(`Agent error: ${agent.agentId}`, "error")
        }
      }
    })
  }, [agents, lastPreviews])
}
```

### 4. API Failures

In any route handler or fetch:

```typescript
try {
  const res = await authFetch("/api/background-agents?cwd=" + cwd)
  if (!res.ok) {
    showNotification(`Failed to fetch agents: ${res.statusText}`, "error")
  }
} catch (err) {
  showNotification(`Network error: ${err.message}`, "error")
}
```

### 5. Session Loading Errors

When user clicks on agent to open its session:

```typescript
const handleLoadSession = useCallback(async (dirName: string, fileName: string) => {
  try {
    const sessionData = await authFetch(`/api/sessions/${dirName}/${fileName}`)
    if (!sessionData.ok) {
      showNotification(`Failed to load session: ${fileName}`, "error")
      return
    }
    // Load session...
  } catch (err) {
    showNotification(`Error loading agent session: ${err.message}`, "error")
  }
}, [])
```

---

## Notification System Design Recommendations

### Toast Component Pattern

Create `src/components/Toast.tsx`:

```typescript
interface ToastProps {
  id: string
  type: "success" | "error" | "warning" | "info"
  message: string
  duration?: number  // ms before auto-dismiss (0 = no auto-dismiss)
  onDismiss: (id: string) => void
}

export function Toast({ id, type, message, duration = 5000, onDismiss }: ToastProps) {
  useEffect(() => {
    if (duration === 0) return
    const timer = setTimeout(() => onDismiss(id), duration)
    return () => clearTimeout(timer)
  }, [duration, id, onDismiss])

  return (
    <div className={cn("rounded px-4 py-2 flex items-center gap-2", {
      "bg-green-950/50 text-green-400 border border-green-500/30": type === "success",
      "bg-red-950/50 text-red-400 border border-red-500/30": type === "error",
      "bg-yellow-950/50 text-yellow-400 border border-yellow-500/30": type === "warning",
      "bg-blue-950/50 text-blue-400 border border-blue-500/30": type === "info",
    })}>
      <span>{message}</span>
      <button onClick={() => onDismiss(id)} className="ml-auto">✕</button>
    </div>
  )
}
```

### ToastContainer (holds multiple toasts)

```typescript
interface Toast {
  id: string
  type: "success" | "error" | "warning" | "info"
  message: string
  duration?: number
}

function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((message: string, type: "success" | "error" | "warning" | "info", duration = 5000) => {
    const id = crypto.randomUUID()
    setToasts(prev => [...prev, { id, message, type, duration }])
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  // Expose globally
  useEffect(() => {
    (window as any).__cogpit_toast = addToast
  }, [addToast])

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(toast => (
        <Toast
          key={toast.id}
          {...toast}
          onDismiss={dismissToast}
        />
      ))}
    </div>
  )
}
```

### Global Toast Hook

```typescript
function useToast() {
  return useCallback((message: string, type = "info", duration = 5000) => {
    (window as any).__cogpit_toast?.(message, type, duration)
  }, [])
}
```

### Usage

```typescript
function StatsPanel({ ... }) {
  const toast = useToast()

  useEffect(() => {
    // Detect completion
    if (wasRunning && !isRunning) {
      toast("Background agent completed", "success")
    }
  }, [isRunning])

  return (
    // component JSX
  )
}
```

### Placement in Layout

Add `<ToastContainer />` to `App.tsx` root:

```typescript
export default function App() {
  return (
    <div className="h-screen flex flex-col">
      <DesktopHeader />
      <div className="flex-1 overflow-hidden">
        {/* main layout */}
      </div>
      <ToastContainer />  {/* ← Toast notifications */}
    </div>
  )
}
```

---

## Color Scheme for Notifications

Use existing Tailwind palette for consistency:

| Type | Colors |
|------|--------|
| **Success** | bg-green-950/50, text-green-400, border-green-500/30 |
| **Error** | bg-red-950/50, text-red-400, border-red-500/30 |
| **Warning** | bg-yellow-950/50, text-yellow-400, border-yellow-500/30 |
| **Info** | bg-blue-950/50, text-blue-400, border-blue-500/30 |

---

## Keyboard Shortcuts

Consider adding shortcuts for agent operations:

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+K` | Kill all background tasks |
| `Ctrl+Shift+A` | Focus first background agent |
| `Ctrl+Shift+↓` | Jump to next background agent |

Register in `src/hooks/useKeyboardShortcuts.ts`.

---

## Testing Notifications

Add test file `src/components/__tests__/Toast.test.ts`:

```typescript
import { render, screen } from "@testing-library/react"
import { Toast } from "@/components/Toast"

describe("Toast", () => {
  it("renders message", () => {
    const onDismiss = vi.fn()
    render(
      <Toast id="1" type="success" message="Test" onDismiss={onDismiss} />
    )
    expect(screen.getByText("Test")).toBeInTheDocument()
  })

  it("auto-dismisses after duration", async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(
      <Toast id="1" type="success" message="Test" duration={1000} onDismiss={onDismiss} />
    )
    vi.runAllTimers()
    expect(onDismiss).toHaveBeenCalledWith("1")
  })
})
```

Run with `bun run test`.

---

## Integration Checklist

- [ ] Create Toast component
- [ ] Create ToastContainer component
- [ ] Add useToast hook
- [ ] Mount ToastContainer in App.tsx
- [ ] Add toast calls in BackgroundAgents component
- [ ] Add toast calls in BackgroundServers component
- [ ] Add toast calls for API errors
- [ ] Add toast calls for agent completion
- [ ] Test with `bun run test`
- [ ] Test in Electron with `bun run electron:dev`
- [ ] Update unit tests for affected components
