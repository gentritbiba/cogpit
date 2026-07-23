# Infinite Scroll Rewrite — Desktop + iOS

**Date:** 2026-07-23
**Status:** Implemented (server + desktop + iOS)
**Mandate:** Current implementation is unstable (jumps on prepend, dribble pages,
dead zones). Full rewrite approved.

**Outcome notes:** browser QA measured 0px visual drift across prepends (desktop
and mobile widths) with chain-loading stopping once 1.5 viewports of buffer are
filled. One bug found only via QA: boundary-turn stitching must keep the NEWER
fragment's id or the on-screen row's key changes and prepend detection breaks.
iOS: scroll choreography rewritten on a UIScrollView-backed anchoring engine
(bounds-origin compensation preserves flick momentum); grouping sealed at page
boundaries so display-item ids survive prepends; `--uitest-scroll` harness +
`TranscriptScrollUITests` cover placement, anchored prepends, and full paging.

## Root causes (from exploration)

| Problem | Desktop | iOS |
|---|---|---|
| Jump on loading older | `PREPEND_TURNS` has no scroll anchoring; virtualizer estimates 200px/turn | 8-id anchor heuristic silently no-ops when activity groups re-merge across page boundaries |
| Too few messages per load | Server converts `count=30` → byte window (64KB/turn) then trims to a 256KB budget; one fat line ≈ empty page | Same server behavior |
| Instability | `firstVisibleIndex < 5` effect trigger, `setTimeout(150)` + triple-rAF, `hasMore` read from mutable singleton during render | `-120pt` arming latch + 4 interacting booleans + `Task.yield()` timing |
| Dead zones | <15 turns → no scroll trigger (manual button only) | Latch blocks chain-loading, so short pages leave a half-empty viewport |

## Design

### 1. Server: record-guaranteed, byte-capped pages

- `?before=off&count=N`: backward read extends (doubling from `count*64KB`) until
  ≥ max(N, 30) complete lines, start-of-content, or 4MB hard cap.
- `?tail=N`: same guarantee — if the 256KB budget trim would leave < 30 complete
  lines, extend the window up to a 2MB cap; `trimTailToByteBudget` gains a
  min-lines floor. Keep-newest-line rule preserved.
- Response shapes unchanged; byteOffset stays byte-exact; gzip keeps wire cost OK.

### 2. Desktop: one virtualized path on `virtua` (per user: use packages)

- Replace @tanstack/react-virtual with **`virtua`**'s `Virtualizer` component in
  custom-scroll-parent mode (keeps ChatArea's container, `useChatScroll`,
  sentinel, FAB). `shift` prop (derived at render: previous first key still
  present at index > 0) preserves scroll position on prepend natively — no
  hand-rolled anchoring. virtua also compensates above-viewport resizes.
- Delete `NonVirtualTimeline` + `VIRTUALIZE_THRESHOLD`; always virtualize.
- Fallback if virtua integration fails QA: TanStack `getItemKey` +
  `shouldAdjustScrollPositionOnItemSizeChange` + layout-effect scrollTop delta.
- Trigger: distance-based — `scrollTop < 1.5 × clientHeight && hasMore &&
  !loading` → `loadMore()`, checked on scroll and after each render. Naturally
  chains until viewport+buffer filled (also fixes short-tail auto-fill on open).
  Gated on initial bottom placement (flag from `useChatScroll`) so opening a
  session doesn't page before the tail is placed.
- `useChunkedSession` → `useSessionPaging`: reactive `hasMore`/`isLoadingOlder`
  state (no render-time singleton reads), still syncs the module sessionCache.
- `PREPEND_TURNS`: merge split boundary turns (chunk's last turn + existing
  first turn when they form one logical turn) instead of dropping records.
- Slim top status row: spinner while loading older; nothing when exhausted.

### 3. iOS: deterministic restore, no latch

- **Stable sealed grouping**: activity-group id = first contained entry id;
  grouping never merges across a page-boundary entry (view model records the
  first entry id before each prepend into a boundary set). Prepends can never
  re-id or re-compose existing display items.
- **UIScrollView-backed scroll anchoring** (the "set way" — what native chat
  apps do): a tiny `UIViewRepresentable` finds the ScrollView's backing
  `UIScrollView` (or SwiftUI-Introspect if preferred). Row frames tracked in a
  *content* coordinate space (change only on layout, not scroll — no per-frame
  churn). Anchoring engine: when not following the bottom, the row overlapping
  the viewport top is the anchor; any change to its content-space Y (prepend,
  above-viewport resize) is compensated by adjusting `scrollView.bounds.origin.y`
  inside `UIView.performWithoutAnimation` — pixel-exact AND preserves flick
  momentum. Replaces scrollTo-based restore and the 8-id heuristic entirely.
- **Trigger**: remove `isTopPagingArmed`; fire when top control within one
  viewport height of the top && phase idle && hasMore. After exact restore the
  offset recheck chains naturally until filled (fixes dead half-empty viewport).
- Keep: `isRestoringOlderPage` suppression, bottom-sentinel stick-to-bottom,
  `contentSignature`, initial placement.

## Tests

- Server: fat-line fixtures — ≥30 lines guaranteed, byte-exact offsets, page
  concat == file, UTF-8 boundary safety, budget floor.
- Desktop: `useSessionPaging` (chain, reset, concurrency), prepend reducer
  (dedupe + boundary merge), pure trigger/anchor helpers in `src/lib/`.
- iOS checks: sealed grouping id-stability across prepends, boundary set,
  anchor-fraction math, phase transitions.

## Verification

Standalone build + agent-browser: scroll-up paging with zero visible jump,
short-tail auto-fill, stick-to-bottom during streaming unaffected. iOS
simulator: same, plus momentum/restore feel.
