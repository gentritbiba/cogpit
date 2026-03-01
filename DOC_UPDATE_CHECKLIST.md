# Documentation Update Checklist

Audit completed: 2026-03-01
All code changes approved. Use this checklist to complete documentation.

---

## Priority 1: CRITICAL (5 min total)

### Update README_ARCHITECTURE.md

#### Task 1a: Add "completed" to SessionStatus documentation
- [ ] Open: `/Users/gentritbiba/.claude/agent-window/README_ARCHITECTURE.md`
- [ ] Find: Session status or SessionStatus section
- [ ] Current value: `"idle" | "thinking" | "tool_use" | "processing"`
- [ ] Add: `"completed"` to the enum/union type
- [ ] Explanation to add:
  ```
  **"completed"** — Agent finished a turn (stop_reason = "end_turn") and user has
  previously sent messages. Indicates that work was performed. Displayed as "Idle"
  in the UI status label, but the internal status distinguishes completed work from
  idle sessions (important for some internal logic).
  ```

#### Task 1b: Update ChatState.pendingMessage to pendingMessages
- [ ] Find: ChatState interface documentation
- [ ] Current:
  ```typescript
  export interface ChatState {
    pendingMessage: string | null
    clearPending: () => void
  }
  ```
- [ ] Replace with:
  ```typescript
  export interface ChatState {
    pendingMessages: string[]  // Queue of messages waiting for session creation
    consumePending: (count?: number) => void  // Remove oldest N messages (default 1)
  }
  ```
- [ ] Add explanation:
  ```
  Multiple messages can queue while a session is being created. consumePending()
  is called by the scroll handler to remove messages as they appear as turns in
  the session.
  ```

#### Task 1c: Update SessionBrowserProps.session to sessionId
- [ ] Find: SessionBrowserProps interface documentation
- [ ] Current:
  ```typescript
  export interface SessionBrowserProps {
    session: ParsedSession | null
  }
  ```
- [ ] Replace with:
  ```typescript
  export interface SessionBrowserProps {
    sessionId: string | null  // UUID of currently selected session
  }
  ```
- [ ] Add explanation:
  ```
  Component only needs the session ID for styling/indication purposes, not the full
  session object. This reduces re-renders when session data updates.
  ```

**Status after Task 1c:** Commit these three updates to complete Priority 1.

---

## Priority 2: HIGH (optional, ~5-10 min)

Choose which of these to update based on what exists in your codebase:

### [ ] Update README.md if it mentions "pending message"
Search for "pending message" or "Pending message"
- Find: Any documentation about pending message indicator
- Update: Show that it now displays queue count (length of array)
- Example: "3 pending messages" instead of "1 pending message"

### [ ] Update ARCHITECTURE.md if it documents getSessionStatus()
Search for "getSessionStatus" or "Progressive read"
- Find: Algorithm documentation section
- Update: Replace single-read algorithm with progressive chunking algorithm
- Key points:
  - Reads 4KB chunks from EOF backward
  - Early exit when meaningful message found
  - MAX_CHUNKS safety cap: 256KB max scan
  - Meaningful messages: assistant, user, queue-operation only

### [ ] Update QUICK_REFERENCE.md if it lists SessionStatus
Search for "SessionStatus" type definition
- Add: "completed" to the enum
- Update: SessionBrowser props section with sessionId instead of session

---

## Priority 3: LOW (informational only, skip if busy)

### Mark design docs as historical (optional)
- [ ] Any docs in `docs/plans/` that mention old APIs
- [ ] Add header: "NOTE: This is a historical design doc. Current implementation varies."
- [ ] No specific updates needed

---

## Verification Steps

Once updates are complete:

```bash
# 1. Verify markdown syntax is valid
cat /Users/gentritbiba/.claude/agent-window/README_ARCHITECTURE.md | head -100

# 2. Run tests (should still pass)
bun run test

# 3. Verify no broken references
grep -r "clearPending\|pendingMessage[^s]" src/

# 4. Verify no broken references to session prop in SessionBrowser
grep -r "props.session" src/components/session-browser/
```

---

## After Updates Complete

1. [ ] All Priority 1 updates applied to README_ARCHITECTURE.md
2. [ ] Ran `bun run test` — all 1029 tests passing
3. [ ] Verified no broken references in codebase
4. [ ] Optionally applied Priority 2 updates
5. [ ] Commit changes with message:
   ```
   docs: audit update — pending queue refactor, completed status, session browser props
   ```
6. [ ] Rename audit file:
   ```bash
   mv audit-history/audit-20260301-040428-PLACEHOLDER.md \
      audit-history/audit-20260301-040428-{short-hash}.md
   ```

---

## Questions?

Refer to full audit report:
`/Users/gentritbiba/.claude/agent-window/audit-history/audit-20260301-040428-PLACEHOLDER.md`

Or quick summary:
`/Users/gentritbiba/.claude/agent-window/AUDIT_SUMMARY_20260301.md`

---

**Checklist created:** 2026-03-01 04:06:00 UTC
**Status:** Ready for documentation updates
