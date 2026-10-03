import { editionModule } from "../edition"
import { prefixMatches } from "../http"

/** Discovery, identity and sign-in: what a client needs before Cogpit is configured. */
const CORE_UNGUARDED_API_PATHS = ["/api/config", "/api/hello", "/api/me", "/api/auth"]

/**
 * Whether an API path answers while Cogpit is not configured yet, when every
 * other API path is refused: core's own, and the running edition's.
 */
export function answersUnconfigured(path: string): boolean {
  return [...CORE_UNGUARDED_API_PATHS, ...editionModule().unguardedApiPaths]
    .some((prefix) => prefixMatches(path, prefix))
}
