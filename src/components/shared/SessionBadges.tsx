import { useEditionUi } from "@/edition/hooks"
import type { ListedAccess } from "../../../shared/contracts/sessionAccess"

/** What the installed edition shows beside a session in a list; nothing without one. */
export function SessionBadges({ access }: { access: ListedAccess | undefined }) {
  const { SessionBadges: EditionBadges } = useEditionUi()
  return EditionBadges ? <EditionBadges access={access} /> : null
}
