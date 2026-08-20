# Audit: Cost-Estimation System Refactor

**Date:** 2026-08-20  
**Status:** PASS

## Change Summary

The app's hardcoded cost-estimation system was replaced with a live LiteLLM-driven pricing engine.

### Removed
- `shared/session/pricingTiers.ts` — hardcoded pricing tiers (Haiku, Sonnet, Opus, Frontier, GPT variants, Fast mode surcharge)
- `src/lib/costAnalytics.ts` — cost aggregation module
- `SessionStats.totalCostUSD` field and all cost computation in `sessionStats.ts`
- `calculateCost()`, `calculateTurnCost()`, `calculateTurnCostEstimated()`, `calculateSubAgentCostEstimated()`, `estimateTotalOutputTokens()`, `estimateSubAgentOutput()` from `shared/session/token-costs.ts`
- Cost estimation helpers from cost-calculation layer

### Added
- Raw API cost engine: `server/lib/usageCost/{transcripts,reader,aggregate,service}.ts`
- `shared/usageCost/pricing.ts` and `shared/contracts/usageCost.ts` with LiteLLM rate-table integration
- New routes:
  - `GET /api/usage-cost/rates` — Live LiteLLM model rate table snapshot (authed)
  - `GET /api/usage-cost?days=&tz=` — Priced cost summary scanning on-disk transcripts (admin-only)
- `UsageCostDialog` desktop header component gated by `viewUsage` capability
- Hooks: `useUsageCost` and `useModelRates` for client-side pricing
- Updated `InputOutputChart` and `ToolCallIndex` to use `priceTokenUsage()` with live rates
- Daily LiteLLM snapshot cache: `<data-root>/usage-model-rates.json`

### Architecture Impact

**Token totals remain in `SessionStats`** — now report raw reported figures only, no estimation or costing. Pricing is deferred to clients (web UI, iOS) that fetch the live rate table and apply it per-turn via `priceTokenUsage()`.

**Cost computation moves to two places:**
1. **Server-side (admin use):** `/api/usage-cost` scans machine-wide transcripts and prices them against the live rate table
2. **Client-side (UI display):** Components fetch `useModelRates()` and compute costs on-the-fly for display, not persistence

## Documentation Changes

### Modified Files

1. **ios/API_MAP.md** (lines 579–581)
   - Added two new routes to Section 6 (Full Route Inventory):
     - `GET /api/usage-cost/rates` — LiteLLM model rates snapshot
     - `GET /api/usage-cost?days=&tz=` — Priced cost summary (admin-only)
   - Context: Routes section already documented `/api/usage` (Claude subscription); new usage-cost routes fit naturally after it.

2. **docs/architecture/README.md** (line 35, session parsing and semantics row)
   - Clarified that pricing applies LiteLLM rates via `shared/usageCost/pricing.ts` and `server/lib/usageCost/*`
   - Emphasizes token totals are raw-reported; pricing is client/server-side concern

### Checked but Not Modified

- **README.md** — Lines 43 and 75 mention "published-price estimates" and "published model pricing" — still accurate (LiteLLM publishes prices; old code had hardcoded snapshots).
- **.claude/skills/cogpit-sessions/SKILL.md** — No cost/pricing references; no changes needed.
- **CLAUDE.md** (project instructions) — No cost/pricing references; no changes needed.
- **docs/** — No stray references to `pricingTiers`, `calculateCost`, `totalCostUSD`, or `costAnalytics` found; docs use concept-level language (e.g., "token costs") rather than implementation details.

### Removed Stale Content

- `scripts/sync-cogpit-memory.ts` no longer includes `pricingTiers.ts` in its FILES list (already removed by the diff).
- Test files cleaned of `totalCostUSD` references (mock data updated in 10+ test files).

## Backward Compatibility

- **SessionStats API change:** `totalCostUSD` field removed. Clients relying on it must use `useModelRates()` hook + `priceTokenUsage()` helper to compute costs from token totals.
- **All other changes are transparent:** internal refactoring; no public session format, hook API, or route contract breaks.

## Verification

1. Route registration: `/api/usage-cost` added to `server/api-routes.ts` (canonical registry).
2. Policy rules: `server/team/policy.ts` gated `/api/usage-cost/rates` as authed, `/api/usage-cost` as admin.
3. Tests: 10+ test files updated to remove `totalCostUSD` from mock `SessionStats`.
4. Component usage: `InputOutputChart` and `ToolCallIndex` import and use `useModelRates()` and `priceTokenUsage()`.

## Recommendation

Consider adding a migration guide to the project notes or docs if **external clients** (iOS, third-party tools) parse SessionStats. They will need to:
1. Remove any code referencing `stats.totalCostUSD`
2. Call `GET /api/usage-cost/rates` and cache the response
3. Use local pricing logic to compute costs from token totals

This audit found no such breakage in the repo itself — all internal references already updated or removed.

---

**Result:** No blocking documentation drift. Two new routes documented in iOS API_MAP. Architecture clarity improved. PASS.
