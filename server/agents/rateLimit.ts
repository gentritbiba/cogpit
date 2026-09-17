/**
 * Rate-limit reports coming off the Agent SDK, read against the capabilities of
 * the CLI that SDK drives.
 *
 * `server/sdk-session.ts` is that CLI's driver but sits outside the agent
 * layer, so it asks for a block instead of naming a kind to read one against.
 */
import { readRateLimitBlock, type RateLimitBlock } from "../../shared/session/rateLimit"

/** Null whenever the SDK is still being served, and for a report it never sent. */
export function readSdkRateLimit(info: unknown): RateLimitBlock | null {
  return readRateLimitBlock("claude", info)
}
