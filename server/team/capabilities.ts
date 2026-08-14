import {
  ALL_CAPABILITIES,
  MEMBER_CAPABILITIES,
  type Capabilities,
  type CogpitEdition,
} from "../../shared/contracts/team"
import type { SessionPrincipal } from "./constants"

/**
 * What the renderer may show for this identity. Personal edition and team
 * admins get everything; everyone else gets the member surface. The server
 * enforces the same boundaries in ROUTE_POLICIES — capabilities only shape UI.
 */
export function computeCapabilities(
  principal: SessionPrincipal | null,
  edition: CogpitEdition,
): Capabilities {
  if (edition === "personal") return ALL_CAPABILITIES
  if (principal?.role === "admin") return ALL_CAPABILITIES
  return MEMBER_CAPABILITIES
}
