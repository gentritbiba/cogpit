/**
 * Pricing tier constants and model-to-tier resolution.
 *
 * Source: Claude Code v2.1.172 binary (decompiled JS bundle).
 * CC uses a model->tier mapping; each tier has five price points.
 *
 * Changes vs the old v2.1.53 table:
 *  - Extended-context (>200k input) pricing is gone — flat pricing per model.
 *  - New frontier tier for Fable 5 / Mythos 5 / Opus 4.8 ($10/$50).
 *  - Sonnet 4.5/4.6 dropped to the $3/$15 tier (was $5/$25).
 *  - Fast mode (usage.speed === "fast" on Opus 4.6/4.7) bills $30/$150;
 *    Opus 4.8 fast bills the same as standard.
 */

// ── Pricing Tiers (per million tokens, USD) ──────────────────────────────────

export interface PricingTier {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  webSearch: number // per request, not per million
}

const TIER_HAIKU_35:  PricingTier = { input: 0.80, output: 4,   cacheWrite: 1,     cacheRead: 0.08, webSearch: 0.01 }
const TIER_HAIKU_45:  PricingTier = { input: 1,    output: 5,   cacheWrite: 1.25,  cacheRead: 0.10, webSearch: 0.01 }
const TIER_SONNET:    PricingTier = { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30, webSearch: 0.01 }
const TIER_OPUS_MID:  PricingTier = { input: 5,    output: 25,  cacheWrite: 6.25,  cacheRead: 0.50, webSearch: 0.01 }
const TIER_FRONTIER:  PricingTier = { input: 10,   output: 50,  cacheWrite: 12.50, cacheRead: 1.00, webSearch: 0.01 }
const TIER_OPUS_LEGACY: PricingTier = { input: 15, output: 75,  cacheWrite: 18.75, cacheRead: 1.50, webSearch: 0.01 }

/** Fast-mode surcharge tier (speed === "fast" on Opus 4.6/4.7). */
const TIER_FAST:      PricingTier = { input: 30,   output: 150, cacheWrite: 37.50, cacheRead: 3.00, webSearch: 0.01 }

// Model -> tier mapping (matched from CC source)
//
// CC normalises full model IDs (e.g. "claude-opus-4-6-20260119") to a short
// key.  We match with `includes()` for robustness; the `[1m]` context suffix
// (e.g. "claude-fable-5[1m]") matches the same entries.
const MODEL_TIERS: Array<{ match: string; tier: PricingTier }> = [
  // Frontier (Fable 5 / Mythos 5 / Opus 4.8)
  { match: "fable-5",        tier: TIER_FRONTIER },
  { match: "mythos-5",       tier: TIER_FRONTIER },
  { match: "opus-4-8",       tier: TIER_FRONTIER },
  // Haiku
  { match: "haiku-4-5",      tier: TIER_HAIKU_45 },
  { match: "haiku-4-0",      tier: TIER_HAIKU_35 },
  { match: "3-5-haiku",      tier: TIER_HAIKU_35 },
  // Sonnet (3.5 through 4.6 — all one tier in current CC)
  { match: "sonnet-4-7",     tier: TIER_SONNET },
  { match: "sonnet-4-6",     tier: TIER_SONNET },
  { match: "sonnet-4-5",     tier: TIER_SONNET },
  { match: "sonnet-4-0",     tier: TIER_SONNET },
  { match: "3-7-sonnet",     tier: TIER_SONNET },
  { match: "3-5-sonnet",     tier: TIER_SONNET },
  // Opus 4.5–4.7
  { match: "opus-4-7",       tier: TIER_OPUS_MID },
  { match: "opus-4-6",       tier: TIER_OPUS_MID },
  { match: "opus-4-5",       tier: TIER_OPUS_MID },
  // Opus legacy (4.0, 4.1)
  { match: "opus-4-1",       tier: TIER_OPUS_LEGACY },
  { match: "opus-4-0",       tier: TIER_OPUS_LEGACY },
]

// Fast mode only applies to these models; Opus 4.8 fast costs the same as
// its standard tier, and other models ignore the speed flag.
const FAST_MODE_MODELS = ["opus-4-6", "opus-4-7"]

// Fallback: opus-mid tier (matches CC's last-resort default)
const DEFAULT_TIER = TIER_OPUS_MID

// Generic fallbacks by model family (when no specific version matches)
const FAMILY_FALLBACKS: Array<{ match: string; tier: PricingTier }> = [
  { match: "fable", tier: TIER_FRONTIER },
  { match: "mythos", tier: TIER_FRONTIER },
  { match: "haiku", tier: TIER_HAIKU_45 },
  { match: "sonnet", tier: TIER_SONNET },
  { match: "opus", tier: TIER_OPUS_MID },
]

export function resolveTier(model: string, speed?: string): PricingTier {
  if (speed === "fast" && FAST_MODE_MODELS.some((m) => model.includes(m))) {
    return TIER_FAST
  }

  // Try specific model versions first
  for (const entry of MODEL_TIERS) {
    if (model.includes(entry.match)) return entry.tier
  }

  // Fall back to model family
  for (const entry of FAMILY_FALLBACKS) {
    if (model.includes(entry.match)) return entry.tier
  }

  return DEFAULT_TIER
}
