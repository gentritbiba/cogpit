# Token Analytics Breakdown

## Overview

Replace the weak "Tokens Per Turn" chart in StatsPanel with a better per-turn I/O visualization, and add detailed token breakdown groupings to the SessionBrowser stats area.

## Part A: Per-Turn I/O Chart (StatsPanel)

Replaces the existing `TokenChart` component in StatsPanel.

**Visual**: For each turn, two side-by-side thin bars:
- **Left bar (blue shades)**: Input tokens — stacked segments for cache read (dim), cache write (medium), new input (bright)
- **Right bar (green/amber)**: Output tokens

**Behavior**:
- Y-axis scales to max across all turns
- Hover tooltip shows exact numbers + cost for that turn
- Turns with sub-agent activity get a small dot indicator below the bar
- ~120px height, same as current chart
- 50+ turns: bars compress, gap between input/output bars shrinks
- Section header: "Input / Output Per Turn"

## Part B: Token Breakdown (SessionBrowser)

Added below the existing stat cards grid in `SessionDetail` component. Collapsible, collapsed by default.

### By Agent (hidden if no sub-agents)
Two rows showing main agent vs sub-agents:
- Input tokens, output tokens, cost for each
- Computed by iterating turns: `turn.tokenUsage` = main agent, `turn.subAgentActivity[].tokenUsage` = sub-agents

### By Model (hidden if only one model)
One row per model used in the session:
- Input tokens, output tokens, cost
- Computed from `turn.model` and sub-agent `sa.model`

### Cache Efficiency
Horizontal stacked bar (full width, ~8px tall):
- Cache read (green), new input (blue), cache write (amber)
- Percentage labels below the bar
- Uses existing `totalCacheReadTokens`, `totalInputTokens`, `totalCacheCreationTokens` from stats

## Data Sources

All data already exists in the parsed session:
- `turn.tokenUsage` — main agent per-turn tokens
- `turn.subAgentActivity[].tokenUsage` — sub-agent tokens
- `turn.model` / `sa.model` — model attribution
- `SessionStats` — aggregated totals
- `calculateTurnCost()` in `src/lib/format.ts` — cost computation

No new API routes or parser changes needed. Pure frontend work.

## Files to Modify

1. `src/components/StatsPanel.tsx` — Replace `TokenChart` with new `InputOutputChart`
2. `src/components/SessionBrowser.tsx` — Add `TokenBreakdown` collapsible below stat cards
3. `src/lib/format.ts` — May need a helper to compute per-agent/per-model breakdowns from turns array
