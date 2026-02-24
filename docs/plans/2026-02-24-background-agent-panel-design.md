# Background Agent Panel Design

## Overview

Add live monitoring for background sub-agents (Task tool calls with `run_in_background: true`). Currently these agents produce `agent_progress` JSONL messages but are rendered identically to foreground sub-agents. This change separates them into a distinct violet-themed panel.

## Changes

### 1. Data Model (`src/lib/types.ts`)

- Add `isBackground: boolean` to `SubAgentMessage`
- Add `{ kind: "background_agent"; messages: SubAgentMessage[]; timestamp?: string }` to `TurnContentBlock` union

### 2. Parser (`src/lib/parser.ts`)

- Track a `Set<string>` of `parentToolUseID`s from Task tool calls with `run_in_background: true`
- When processing `agent_progress` messages, check if `parentToolUseID` is in the background set
- Set `isBackground: true` on tagged `SubAgentMessage`s
- Flush background agent messages as `kind: "background_agent"` blocks (separate from `kind: "sub_agent"`)

### 3. Component (`src/components/timeline/BackgroundAgentPanel.tsx`)

- Structurally identical to `SubAgentPanel`
- Violet theme: `border-violet-500/30`, `text-violet-400` icons/labels
- Agent color palette: violet, fuchsia, purple, pink, sky
- Label: "Background agent activity"
- Default closed (same as sub-agents)

### 4. Timeline Renderer

- Add `case "background_agent"` dispatching to `BackgroundAgentPanel`

## Non-changes

- No server/API/SSE/Electron changes needed
- Flat `subAgentActivity` array on Turn still contains all messages (both types) for search/stats
