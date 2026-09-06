// Browser-safe: what a managed browser may be called. Declared once here
// because both sides need it and neither may import the other — the server
// creates the directories, the transcript scan in `shared/session` reads the
// name back out of an `agent-browser` command line. No node imports.

/** The browser every call lands in when no `--session` is given. */
export const DEFAULT_BROWSER = "default"
/** A `tmp-*` browser is a subagent's throwaway: no profile, never shown in the panel. */
export const THROWAWAY_PREFIX = "tmp-"

/** Also rendered into the shim, which validates the name before touching the tree. */
export const BROWSER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
/** The longest name `BROWSER_NAME_RE` accepts, for callers that build one. */
export const MAX_BROWSER_NAME_LENGTH = 40

export function isValidBrowserName(name: string): boolean {
  return BROWSER_NAME_RE.test(name)
}

export function isThrowawayName(name: string): boolean {
  return name.startsWith(THROWAWAY_PREFIX)
}
