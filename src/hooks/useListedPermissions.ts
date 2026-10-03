import { useCurrentUser } from "@/hooks/useCurrentUser"
import {
  permissionsForAccess,
  type SessionAccessState,
  type SessionActionPermissions,
} from "@/lib/sessionAccessPermissions"
import type { ListedAccess } from "../../shared/contracts/sessionAccess"

/**
 * Permissions for the rows of a session list. A server that enforces session
 * access annotates every row with the caller's access, so a row without it is
 * read-only there; elsewhere rows carry none and are the user's own. Every row
 * is read-only while the identity is unresolved.
 */
export function useListedPermissions(): (access: ListedAccess | undefined) => SessionActionPermissions {
  const { enforcesSessionAccess } = useCurrentUser()
  const unlisted: SessionAccessState = enforcesSessionAccess === false ? "own" : "unknown"
  return (access) => permissionsForAccess(enforcesSessionAccess !== null && access ? access.level : unlisted)
}
