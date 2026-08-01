# Mission Control

A center-pane grid of every live agent session, built so sessions blocked on the
user are impossible to miss. Reached from the header button or `⌘⇧M`
(`mainView: "mission"`, `OPEN_MISSION` / `CLOSE_MISSION`).

## Where things live

| Piece | Path |
| --- | --- |
| View (toolbar + grid, cards, inline prompts) | `src/components/MissionControl/` |
| Pure filter/sort/format | `src/components/MissionControl/missionControlView.ts` |
| Shared session inventory (one fetch, one poll) | `src/contexts/SessionInventoryContext.tsx` |
| Pending permissions + questions poll | `src/contexts/PendingHumanInputContext.tsx` |
| Card summaries | `server/lib/missionControlSummary.ts`, `server/routes/mission-control.ts` |
| Blocking requests | `server/routes/permissions.ts`, `server/routes/ask-user.ts` |
| Wire types | `shared/contracts/missionControl.ts` |

## Decisions worth knowing

- **One inventory, one poll.** `SessionInventoryContext` owns fetch, abort,
  localStorage cache, `newlyCompleted` tracking, and visibility-gated polling.
  `LiveSessions`, Mission Control, and the header badge all consume it, so
  opening the grid adds no second poll.
- **Summaries are tailed, not re-parsed.** Live JSONL files grow constantly, so
  an mtime cache alone always misses. `missionControlSummary.ts` keeps a
  per-file accumulator and reads only the bytes appended since the last poll;
  a shrunk or replaced file falls back to a full read. Steady-state cost is
  proportional to new output, not session size.
- **Two kinds of blocking, one attention path.** Permissions
  (`GET /api/permissions`) depend on permission mode; AskUserQuestion
  (`GET /api/user-questions`) blocks even under `bypassPermissions`. Both feed
  `classifyAttention`, which takes a set for each, so the sidebar attention strip
  catches them too. Questions are read from the in-memory resolver map — a
  session whose server restarted simply is not listed.
- **Cards answer without opening the session.** Both respond endpoints resolve by
  session id alone. `QuestionPrompt` bails out to "open the session" only when a
  question needs free text or an option carries a preview.

## Environment constraints

- `animate-pulse` / `animate-ping` are globally disabled (`animation: none
  !important`) for GPU reasons — use the existing `.live-pulse`.
- shadcn here is the **Base UI** variant: `render={...}`, not `asChild`.
- There is no `Progress` primitive; the context bar is hand-rolled.
- Cards use the real elevation tokens (`bg-elevation-2`).

## Out of scope

The right-rail cross-session activity feed, per the original brief.
