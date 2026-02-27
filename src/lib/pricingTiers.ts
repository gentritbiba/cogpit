/**
 * Pricing tier constants and model-to-tier resolution.
 *
 * Source: Claude Code v2.1.53 binary (decompiled JS bundle).
 * CC uses a model->tier mapping; each tier has five price points.
 */

// ── Pricing Tiers (per million tokens, USD) ──────────────────────────────────

export interface PricingTier {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  webSearch: number // per request, not per million
}

/** Total input tokens above this threshold trigger extended context pricing. */
export const EXTENDED_CONTEXT_THRESHOLD = 200_000

// Standard tiers
const TIER_HAIKU_35:         PricingTier = { input: 0.80, output: 4,     cacheWrite: 1,     cacheRead: 0.08, webSearch: 0.01 }
const TIER_HAIKU_45:         PricingTier = { input: 1,    output: 5,     cacheWrite: 1.25,  cacheRead: 0.10, webSearch: 0.01 }
const TIER_SONNET_LEGACY:    PricingTier = { input: 3,    output: 15,    cacheWrite: 3.75,  cacheRead: 0.30, webSearch: 0.01 }
const TIER_SONNET_LATEST:    PricingTier = { input: 5,    output: 25,    cacheWrite: 6.25,  cacheRead: 0.50, webSearch: 0.01 }
const TIER_OPUS_LEGACY:      PricingTier = { input: 15,   output: 75,    cacheWrite: 18.75, cacheRead: 1.50, webSearch: 0.01 }

// Extended context tiers (total input > 200k tokens)
const TIER_SONNET_LEGACY_EXT: PricingTier = { input: 6,   output: 22.5,  cacheWrite: 7.50,  cacheRead: 0.60, webSearch: 0.01 }
const TIER_EXTENDED:          PricingTier = { input: 10,   output: 37.5,  cacheWrite: 12.50, cacheRead: 1.00, webSearch: 0.01 }

// Model -> tier mapping (matched from CC source)
//
// CC normalises full model IDs (e.g. "claude-opus-4-6-20260119") to a short
// key.  We match with `includes()` for robustness.
export const MODEL_TIERS: Array<{ match: string; tier: PricingTier; extendedTier?: PricingTier }> = [
  // Haiku
  { match: "haiku-4-5",      tier: TIER_HAIKU_45 },
  { match: "haiku-4-0",      tier: TIER_HAIKU_35 },
  { match: "3-5-haiku",      tier: TIER_HAIKU_35 },
  // Sonnet latest (4.5+)
  { match: "sonnet-4-6",     tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  { match: "sonnet-4-5",     tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  // Sonnet legacy (3.5, 3.7, 4.0)
  { match: "sonnet-4-0",     tier: TIER_SONNET_LEGACY, extendedTier: TIER_SONNET_LEGACY_EXT },
  { match: "3-7-sonnet",     tier: TIER_SONNET_LEGACY, extendedTier: TIER_SONNET_LEGACY_EXT },
  { match: "3-5-sonnet",     tier: TIER_SONNET_LEGACY, extendedTier: TIER_SONNET_LEGACY_EXT },
  // Opus latest (4.5+) — same tier as sonnet latest
  { match: "opus-4-6",       tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  { match: "opus-4-5",       tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  // Opus legacy (4.0, 4.1)
  { match: "opus-4-1",       tier: TIER_OPUS_LEGACY },
  { match: "opus-4-0",       tier: TIER_OPUS_LEGACY },
]

// Fallback: sonnet-latest tier (matches CC's default for opus-4-6, the current default model)
const DEFAULT_TIER = TIER_SONNET_LATEST
const DEFAULT_EXTENDED_TIER = TIER_EXTENDED

// Generic fallbacks by model family (when no specific version matches)
export const FAMILY_FALLBACKS: Array<{ match: string; tier: PricingTier }> = [
  { match: "haiku", tier: TIER_HAIKU_45 },
  { match: "sonnet", tier: TIER_SONNET_LATEST },
  { match: "opus", tier: TIER_SONNET_LATEST },
]

export function resolveTier(model: string, totalInputTokens?: number): PricingTier {
  const isExtended = (totalInputTokens ?? 0) > EXTENDED_CONTEXT_THRESHOLD

  // Try specific model versions first
  for (const entry of MODEL_TIERS) {
    if (model.includes(entry.match)) {
      return (isExtended && entry.extendedTier) ? entry.extendedTier : entry.tier
    }
  }

  // Fall back to model family
  for (const entry of FAMILY_FALLBACKS) {
    if (model.includes(entry.match)) return entry.tier
  }

  return isExtended ? DEFAULT_EXTENDED_TIER : DEFAULT_TIER
}
