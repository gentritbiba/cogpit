import { shallowEqual } from "@/lib/store"
import type { PendingInteraction } from "../../shared/session/parser"
import type { ModelFallbackNotice } from "../../shared/session/sessionDigest"

/*
 * Equality for facts the shell selects from the open session. Each streamed
 * batch derives them afresh, so they compare by what they say, not by object.
 */

export function samePendingInteraction(a: PendingInteraction, b: PendingInteraction): boolean {
  return a === b || (a !== null && b !== null && shallowEqual<object>(a, b))
}

export function sameModelFallback(a: ModelFallbackNotice | null, b: ModelFallbackNotice | null): boolean {
  return a?.id === b?.id
}
