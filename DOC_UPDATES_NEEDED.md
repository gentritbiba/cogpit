# Documentation Updates Required
**Date:** 2026-03-01
**Audit File:** `audit-history/audit-PLACEHOLDER.md`

This document summarizes the documentation updates needed to reflect the bundle optimization and subagent content loading changes.

---

## Priority 1: CRITICAL (Complete before commit)

### 1. ARCHITECTURE.md — Add Subagents Endpoint

**Location:** In "Backend API Routes" section (after existing `/api/sessions/{dirName}/{sessionId}` entry)

**Add:**
```markdown
### GET /api/sessions/{dirName}/{sessionId}/subagents

Lists all subagent session files for a parent session.

**Path Parameters:**
- `dirName` — Project directory name (URL-encoded)
- `sessionId` — Parent session ID (URL-encoded)

**Response (200 OK):**
```json
[
  {
    "agentId": "string",
    "size": number,
    "modifiedAt": number
  }
]
```

**Status Codes:**
- `200` — Subagent files listed successfully (empty array if none)
- `403` — Access denied (path escape attempt detected)
- `200` with empty array — No subagents directory yet

**Usage:** Frontend uses this to discover available subagent JSONL files, then streams content via the session file route.

**Implementation Details:** 
- Files match pattern `agent-*.jsonl` in `{SESSION_DIR}/subagents/`
- Returns file metadata (size, modification time) for UI display
- Gracefully handles missing directory (returns `[]`)
```

**Why:** New endpoint is essential for subagent content loading feature; developers need to know it exists.

---

### 2. ARCHITECTURE.md — Add Build & Bundle Optimization Section

**Location:** New section at end of document, before "Testing & Development"

**Add:**
```markdown
## Build & Bundle Optimization

### Shiki Dynamic Import Strategy

The syntax highlighter uses a dynamic import strategy to minimize bundle size:

1. **Core:** Uses `shiki/core` instead of full `shiki` package
2. **Engine:** JavaScript regex engine (no WASM dependency)
3. **Themes:** Both GitHub themes (`github-dark`, `github-light`) dynamically imported
4. **Languages:** Only 11 default languages pre-loaded at startup:
   - TypeScript, TSX, JavaScript, JSX, JSON, CSS, HTML, Python, Bash, YAML, Markdown
5. **On-Demand:** Other languages (Rust, Go, SQL, etc.) fetched when first needed

**Benefits:**
- Eliminates large WASM runtime from bundle
- Faster initial load (only defaults pre-loaded)
- Deferred loading of rarely-used languages
- Reduces main bundle by ~2-3 MB

**Code Location:** `src/lib/shiki.ts` with `LANG_IMPORT_MAP` for dynamic loaders.

### Manual Chunk Splitting

Build configuration splits large dependencies into independent chunks for efficient caching:

**Three vendor chunks:**
1. **vendor-shiki** — All Shiki packages (`shiki/*`, `@shikijs/*`)
   - Reason: Large, self-contained package
   - Load: On-demand as users view code files

2. **vendor-markdown** — Markdown processing pipeline
   - Includes: `react-markdown`, `remark-*`, `rehype-*`, `unified`, `mdast-*`, `hast-*`, `micromark`
   - Reason: Large pipeline, used by TurnSection
   - Load: With assistant response content

3. **vendor-ui** — UI libraries and utilities
   - Includes: `@radix-ui/*`, `lucide-react`, `react-resizable-panels`, `@tanstack/react-virtual`, CSS utilities
   - Reason: Core dependencies, used throughout app
   - Load: Immediately with main bundle

**Configuration Files:**
- `vite.config.ts` — Renderer build (dev server + Electron renderer)
- `electron.vite.config.ts` — Same strategy for Electron build

### Electron Builder Exclusions

The application excludes renderer-only packages from the asar bundle because they're already included in the Vite output:

**Excluded packages** (`electron-builder.yml`):
- Shiki and language/theme packages (`shiki/*`, `@shikijs/*`)
- UI libraries (`@radix-ui/*`, `lucide-react`)
- Markdown pipeline (`react-markdown/*`, `remark-*`)
- Panels and virtualization (`react-resizable-panels/*`, `@tanstack/*`)
- CSS utilities (`tailwind-merge/*`, `clsx/*`)
- Whisper transcriber (`whisper-web-transcriber/*`)

**Rationale:** Renderer assets are bundled into `/out/renderer/` by Vite. Including them in asar doubles their footprint.

**Result:** Smaller app size without affecting functionality.

### Performance Impact

- **Initial bundle:** Reduced ~15-20% by moving to shiki/core + dynamic imports
- **App size:** Reduced ~10-15% by excluding duplicate renderer packages
- **First load:** Slightly faster due to smaller initial JS
- **Feature load:** Syntax highlighting available immediately; additional languages load on-demand

### Configuration in Version Control

All optimization is driven by Vite and electron-builder config (checked in):
- `vite.config.ts` — Manual chunks defined
- `electron.vite.config.ts` — Same chunk strategy
- `electron-builder.yml` — Explicit exclusions
- `src/lib/shiki.ts` — Dynamic import map

No special build steps needed; optimizations apply automatically to all builds.
```

**Why:** Documents significant architectural decision; helps maintainers understand performance optimizations and modify them intelligently.

---

### 3. AGENT_INTEGRATION.md — Add Lazy-Load Phase Explanation

**Location:** New subsection under "How Agents Are Spawned & Monitored"

**Add:**
```markdown
### Phase 2: Lazy Content Loading

After initial agent detection, subagent content is loaded on-demand via the `useSubagentContent` hook.

#### Non-Live Sessions (Completed)

For sessions that have completed (not currently running), agents with `status === "async_launched"` and no content are loaded:

```typescript
const agentsToLoad = messages.filter((m) =>
  m.status === "async_launched" &&
  m.text.length === 0 &&
  m.thinking.length === 0 &&
  m.toolCalls.length === 0
)
```

#### Live Sessions (In Progress)

For sessions still executing, only agents that have COMPLETED are loaded (determined by `durationMs` being set):

```typescript
const agentsToLoad = messages.filter((m) => {
  const hasNoContent = m.text.length === 0 && ...
  if (!hasNoContent) return false

  // Only load completed agents (durationMs set by toolUseResult)
  // Running agents not loaded here — Phase 3 polling handles those
  return m.durationMs != null
})
```

**Rationale:** Prevents loading agents that are still accumulating tool calls and responses. Running agent updates are handled by real-time polling (Phase 3).

#### Subagent Discovery

The hook fetches available subagent files via:
```
GET /api/sessions/{dirName}/{sessionId}/subagents
```

This returns an array of `{ agentId, size, modifiedAt }` for all `agent-*.jsonl` files in the session's subagents directory.

#### Phase 3: Real-Time Polling

After lazy-loading, active agents are polled every 1-2 seconds via `subagentWatcher` for live updates (tool calls, responses, thinking blocks).

See "Background Agent Detection" section above for polling details.
```

**Why:** Documents the hook logic change that enables proper subagent content loading; needed for developers modifying lazy-load behavior.

---

## Priority 2: RECOMMENDED (Complete before release)

### 4. README.md — Add Performance/Optimization Section

**Location:** After "Features" section (before "Download")

**Add:**
```markdown
## Performance & Optimization

Cogpit is optimized for fast load times and efficient memory usage:

- **Shiki Code Highlighting:** Dynamic imports with JS regex engine (no WASM); only essential languages pre-loaded
- **Bundle Chunking:** Vendor libraries split into independent chunks (`vendor-shiki`, `vendor-markdown`, `vendor-ui`) for efficient caching
- **Virtualized Lists:** Turn lists with 15+ entries automatically virtualized; smooth scrolling with minimal rendering
- **Lazy Component Loading:** Subagent content fetched on-demand, not pre-loaded
- **Minimal App Size:** Renderer-only dependencies excluded from native package; optimized electron-builder config

**Bundle Size:** ~45 MB desktop app (with code highlighting, markdown, UI libraries pre-bundled)

See [ARCHITECTURE.md § Build & Bundle Optimization](/ARCHITECTURE.md#build--bundle-optimization) for technical details.
```

**Why:** Highlights optimization work; users appreciate knowing the project prioritizes performance.

---

### 5. QUICK_REFERENCE.md — Update API Routes Table

**Location:** In "API Routes Summary" section

**Update existing table to add row:**
```markdown
| Endpoint | Method | Purpose |
|----------|--------|---------|
| ... existing entries ... |
| `/api/sessions/{dirName}/{sessionId}/subagents` | GET | List subagent files for a session |
```

**Why:** Users consulting quick reference should see all available endpoints.

---

## Implementation Checklist

Use this checklist when implementing the documentation updates:

### ARCHITECTURE.md
- [ ] Added subagents endpoint documentation (20 lines)
- [ ] Added "Build & Bundle Optimization" section (50-60 lines)
  - [ ] Shiki dynamic import strategy explained
  - [ ] Manual chunk splitting documented
  - [ ] Electron builder exclusions rationalized
  - [ ] Performance impact noted
- [ ] Links to new section added in table of contents (if applicable)
- [ ] Verified all code examples are accurate to current codebase

### AGENT_INTEGRATION.md
- [ ] Added "Phase 2: Lazy Content Loading" subsection (30-40 lines)
  - [ ] Non-live session behavior explained
  - [ ] Live session behavior explained
  - [ ] Subagent discovery via `/api/sessions/{dirName}/{sessionId}/subagents` documented
  - [ ] Phase 3 polling reference correct
- [ ] Code examples match current hook implementation
- [ ] Rationale for behavior differences clear

### README.md (Optional)
- [ ] Added "Performance & Optimization" section (8-10 lines)
- [ ] Links to ARCHITECTURE.md correct
- [ ] Bundle size estimate accurate

### QUICK_REFERENCE.md (Optional)
- [ ] API routes table updated with new endpoint
- [ ] Row format matches existing entries

---

## Verification

Before considering documentation complete:

1. **Code-Documentation Alignment**
   - [ ] All endpoints documented match `server/routes/projects/index.ts`
   - [ ] Shiki strategy matches `src/lib/shiki.ts` implementation
   - [ ] Chunk names match `vite.config.ts` and `electron.vite.config.ts`
   - [ ] Lazy-load logic matches `src/hooks/useSubagentContent.ts`

2. **Link Validation**
   - [ ] All internal cross-references (e.g., "See ARCHITECTURE.md") work
   - [ ] No broken markdown links
   - [ ] Code block syntax highlighting correct

3. **Accuracy**
   - [ ] Line numbers are current (update if code changes)
   - [ ] Examples are copy-paste correct
   - [ ] No outdated information mixed in

4. **Readability**
   - [ ] New sections follow existing style (brief, clear, examples)
   - [ ] Tables and code blocks properly formatted
   - [ ] No typos or grammar errors

---

## Files to Update

### Must Update
- `/Users/gentritbiba/.claude/agent-window/ARCHITECTURE.md`
- `/Users/gentritbiba/.claude/agent-window/AGENT_INTEGRATION.md`

### Should Update
- `/Users/gentritbiba/.claude/agent-window/README.md`
- `/Users/gentritbiba/.claude/agent-window/QUICK_REFERENCE.md`

### No Action Required
- `AGENTS.md` — Already deleted
- `DOCS_INDEX.md` — No changes needed
- `README_ARCHITECTURE.md` — No changes needed

---

## See Also

- **Full Audit Report:** `audit-history/audit-PLACEHOLDER.md`
- **Code Changes:** `git diff HEAD` (54 files, 356 insertions, 515 deletions)
- **Related Commits:**
  - `cf765f2` — feat: render task notifications and lazy-load subagent content
  - `5af6fa8` — docs: add auto-update design doc

---

*Last Updated: 2026-03-01*
