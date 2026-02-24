# Documentation Index

This project has comprehensive architecture and integration documentation. Start here.

## Quick Start (5 minutes)

1. **What is this?** → Read `/Users/gentritbiba/.claude/agent-window/README_ARCHITECTURE.md`
2. **How do I run it?** → See the "Running the App" section
3. **Where's the code?** → See the "File Organization" section
4. **How do background agents work?** → Jump to AGENT_INTEGRATION.md

## Core Documentation

### 1. README_ARCHITECTURE.md (START HERE)
**Purpose:** Executive summary of the entire project
**Length:** ~3 pages
**Contents:**
- What Cogpit does (real-time dashboard for Claude Code)
- How it launches (Electron → Express → React)
- Background agent integration overview
- File organization
- Running commands
- Testing overview
- Key takeaways

**When to read:** First time understanding the project, quick overview, answers to "what is this?"

---

### 2. ARCHITECTURE.md (DETAILED REFERENCE)
**Purpose:** Complete technical deep-dive
**Length:** ~10 pages
**Contents:**
- Electron main process execution
- Express server with dual route registration (CRITICAL PATTERN)
- How agents are monitored (5 stages of detection)
- Complete API routes table (12+ endpoints)
- Data models (SubAgentMessage, TurnContentBlock)
- Session parsing logic
- UI component structure
- Design patterns explained
- Security & permissions
- Testing policy
- Development workflow

**When to read:** Implementing new features, understanding architecture decisions, modifying routes

---

### 3. AGENT_INTEGRATION.md (IMPLEMENTATION GUIDE)
**Purpose:** How to work with background agents and implement notifications
**Length:** ~8 pages
**Contents:**
- How agents are spawned (Task tool execution)
- API endpoints for agent monitoring (background-agents, background-tasks)
- Data structures (SubAgentMessage with isBackground flag)
- Current UI display (StatsPanel, BackgroundAgentPanel)
- 5 specific locations to add notifications
- Complete Toast component implementation
- Color scheme for notifications
- Keyboard shortcuts
- Testing notifications
- Integration checklist

**When to read:** Adding notification system, monitoring background agents, implementing new features

---

### 4. QUICK_REFERENCE.md (LOOKUP GUIDE)
**Purpose:** Quick answers to common questions
**Length:** ~6 pages
**Contents:**
- Architecture diagram
- Running commands
- API routes summary table
- Component hierarchy visual
- Key types quick reference
- Critical file paths
- Common tasks (add route, add component, monitor agents)
- Keyboard shortcuts
- Styling & theme
- Debugging tips
- Common issues & fixes
- Performance notes
- Security summary
- Support resources

**When to read:** Quick lookup, finding specific routes, debugging issues, common tasks

## Document Navigation

### "I want to understand..."

**...what this app does**
→ README_ARCHITECTURE.md § "What This App Is"

**...how the app launches**
→ README_ARCHITECTURE.md § "How It Launches & Executes"
→ ARCHITECTURE.md § "App Launch & Execution"

**...how background agents work**
→ README_ARCHITECTURE.md § "Background Agent Integration"
→ AGENT_INTEGRATION.md § "How Agents Are Spawned & Monitored"
→ ARCHITECTURE.md § "How Agents Are Executed & Monitored"

**...where to find code**
→ README_ARCHITECTURE.md § "File Organization"
→ QUICK_REFERENCE.md § "File Structure (Critical Paths)"
→ ARCHITECTURE.md § "File Organization"

**...how to add a new feature**
→ QUICK_REFERENCE.md § "Common Tasks"
→ ARCHITECTURE.md § "Quick Reference: Adding a New Feature"

**...how to add notifications**
→ AGENT_INTEGRATION.md § "Notification System Design Recommendations"
→ AGENT_INTEGRATION.md § "Integration Checklist"

**...what routes are available**
→ QUICK_REFERENCE.md § "API Routes Summary"
→ ARCHITECTURE.md § "Backend API Routes"

**...how to debug something**
→ QUICK_REFERENCE.md § "Debugging" + "Common Issues & Fixes"
→ ARCHITECTURE.md § "Security"

**...the data structures**
→ QUICK_REFERENCE.md § "Key Types"
→ AGENT_INTEGRATION.md § "Data Structures"
→ ARCHITECTURE.md § "Data Model: Background Agents"

## Key Concepts

### Dual Route Registration (CRITICAL!)

Every API route must be registered in **BOTH** places:
1. `server/api-plugin.ts` — Vite plugin (dev server)
2. `electron/server.ts` — Express server (production)

If only one, route fails in the other environment.

**Documentation:** ARCHITECTURE.md § "Backend API Routes", QUICK_REFERENCE.md § "Dual Registration Pattern"

### Background Agent Detection

1. Claude calls Task tool with `run_in_background: true`
2. Task output written to `/private/tmp/claude-{uid}/{hash}/tasks/`
3. Parser detects and tags with `isBackground: true`
4. Frontend polls `/api/background-agents` every 5 seconds
5. Displays in StatsPanel with violet theme

**Documentation:** AGENT_INTEGRATION.md § "1. Agent Spawning", § "API Endpoints for Agent Monitoring"

### Session Parsing

JSONL files are parsed into `ParsedSession` objects with:
- `Turn[]` — conversation turns
- `contentBlocks` — ordered content (thinking, text, tool calls, agents)
- `stats` — aggregated metrics
- Background agents in separate `kind: "background_agent"` blocks

**Documentation:** ARCHITECTURE.md § "Session Parsing: Background Agent Detection", QUICK_REFERENCE.md § "Key Types"

### Component Architecture

Desktop layout:
```
App.tsx
├── SessionBrowser (sidebar)
├── ConversationTimeline (main chat)
│   └── Renders TurnContentBlock[]
│       ├── SubAgentPanel (blue)
│       └── BackgroundAgentPanel (violet)
└── StatsPanel (right)
    ├── TokenChart
    ├── BackgroundServers (blue)
    └── BackgroundAgents (violet)
```

**Documentation:** ARCHITECTURE.md § "UI Component Structure", QUICK_REFERENCE.md § "Component Hierarchy"

## File Locations

```
/Users/gentritbiba/.claude/agent-window/

Core Documentation:
├── README_ARCHITECTURE.md     ← START HERE
├── ARCHITECTURE.md            ← Detailed reference
├── AGENT_INTEGRATION.md       ← Implementation guide
├── QUICK_REFERENCE.md         ← Quick lookup
└── DOCS_INDEX.md             ← This file

Source Code:
├── electron/
│   ├── main.ts               ← Electron entry point
│   └── server.ts             ← Express server
├── src/
│   ├── App.tsx               ← React root
│   ├── components/           ← 35+ components
│   ├── hooks/                ← 25+ custom hooks
│   └── lib/
│       ├── parser.ts         ← Session parsing
│       └── types.ts          ← TypeScript interfaces
└── server/
    ├── routes/               ← 12 API route modules
    ├── api-plugin.ts         ← Vite plugin
    └── pty-plugin.ts         ← WebSocket PTY
```

## Reading Order Recommendations

### For First-Time Understanding
1. README_ARCHITECTURE.md (15 min)
2. QUICK_REFERENCE.md (10 min)
3. ARCHITECTURE.md (30 min)

### For Implementing Notifications
1. AGENT_INTEGRATION.md § "Current UI Display" (5 min)
2. AGENT_INTEGRATION.md § "Where to Add Notifications" (10 min)
3. AGENT_INTEGRATION.md § "Notification System Design Recommendations" (20 min)

### For Adding a New API Route
1. QUICK_REFERENCE.md § "Dual Registration Pattern" (5 min)
2. ARCHITECTURE.md § "Backend API Routes" (10 min)
3. Look at existing route in `server/routes/` (5 min)
4. Copy pattern and implement

### For Debugging
1. QUICK_REFERENCE.md § "Common Issues & Fixes" (5 min)
2. QUICK_REFERENCE.md § "Debugging" (5 min)
3. ARCHITECTURE.md § "Security" (5 min)

## Documentation Scope

### What's Covered

✓ App architecture and execution flow
✓ Background agent monitoring
✓ API routes and endpoints
✓ Data types and models
✓ Component structure
✓ Session parsing logic
✓ Running and building
✓ Testing approach
✓ Common patterns
✓ How to add features
✓ How to add notifications
✓ File locations
✓ Keyboard shortcuts
✓ Debugging tips
✓ Security considerations

### What's NOT Covered

✗ Detailed line-by-line code explanation (see comments in source)
✗ Individual component implementation (see component files)
✗ React/Electron/TypeScript fundamentals (see official docs)
✗ Specific hooks internals (see `src/hooks/`)
✗ Styling details (see `src/index.css` and Tailwind CSS docs)

## Quick Commands

```bash
# Development
bun run dev                # Browser dashboard
bun run electron:dev       # Electron with hot reload

# Building
bun run build              # Build web
bun run electron:package   # Build Electron

# Testing & Linting
bun run test              # Run tests
bun run test:watch        # Watch mode
bun run lint              # ESLint + type check
bun run typecheck         # TypeScript check
```

## Common Questions

**Q: Where do I start?**
A: Read README_ARCHITECTURE.md first (5 minutes)

**Q: How do I add a notification?**
A: See AGENT_INTEGRATION.md § "Notification System Design Recommendations"

**Q: Where are the routes?**
A: `/server/routes/` (12 modules) — must register in BOTH api-plugin.ts and server.ts

**Q: How do background agents work?**
A: See AGENT_INTEGRATION.md § "How Agents Are Spawned & Monitored"

**Q: What's with the "dual registration"?**
A: See ARCHITECTURE.md § "Backend API Routes" or QUICK_REFERENCE.md § "Dual Registration Pattern"

**Q: How do I run tests?**
A: `bun run test` — files are in `src/__tests__/` and `server/__tests__/`

**Q: Where's the Electron code?**
A: `electron/main.ts` (app entry) and `electron/server.ts` (Express server)

**Q: How's the UI organized?**
A: See QUICK_REFERENCE.md § "Component Hierarchy" or ARCHITECTURE.md § "UI Component Structure"

## Support & Resources

- **Official docs:** See end of QUICK_REFERENCE.md § "Useful Links"
- **Type definitions:** `src/lib/types.ts`
- **Parser logic:** `src/lib/parser.ts`
- **Example routes:** `server/routes/*.ts`
- **Example components:** `src/components/*.tsx`
- **Test examples:** `src/__tests__/*.test.ts`

## Last Updated

These docs were created on 2026-02-24 and reflect the current codebase state.

The project is in **Phase 2 (Core Features)** with:
- ✓ Session browsing
- ✓ Live streaming
- ✓ Background agent monitoring
- ✓ Team dashboards
- ✓ Undo/redo with branching
- ✓ Voice input (Whisper)
- ✓ Network access
- ✗ Notification system (not yet implemented)

See `CLAUDE.md` in this directory for project status.
