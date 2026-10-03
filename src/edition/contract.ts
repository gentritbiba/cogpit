// ── The renderer's edition seam ─────────────────────────────────────────
//
// An edition package adds UI to core only through these typed slots; a build
// without one renders every slot's personal default. A slot is a component, a
// plain value, a pure function or an external store, never a hook: the UI is
// installed while components are mounted (a hub switching to another edition's
// device), and a hook slot would change their hook order.

import type { ComponentType } from "react"
import type { LucideIcon } from "lucide-react"
import type { AccountPublic, Capabilities, CogpitEdition } from "../../shared/contracts/identity"
import type { ListedAccess } from "../../shared/contracts/sessionAccess"
import type { CogpitNotification } from "../../shared/notifications"

/** Identity as a slot may read it: at render time, for the active device. */
export interface EditionIdentity {
  edition: CogpitEdition | null
  user: AccountPublic | null
  hubUser: AccountPublic | null
  can(capability: keyof Capabilities | (string & {})): boolean
}

/** A full-screen view beside sessions, config and Mission Control. */
export interface EditionMainView {
  id: string
  /** The palette offers "Open {label}" and "Close {label}". */
  label: string
  icon: LucideIcon
  /** Palette search terms. */
  keywords: string
  /** Pure, never a hook. */
  isAvailable(identity: EditionIdentity): boolean
  /** Asked once per app mount, when the view first becomes available, until a view opens; true opens it. */
  openOnStart?(): boolean
  /** Full screen on mobile, so it swallows the tab swipe. */
  locksSwipe?: boolean
  Component: ComponentType<{ onClose(): void }>
}

/** An external store, never a hook, so it can appear under already-mounted providers. */
export interface SessionListFilter {
  subscribe(listener: () => void): () => void
  /** Null is unfiltered, the default list. Opaque: it keys the list cache and each request. */
  getKey(): string | null
  /** Params every list request appends. The same key must return the same object. */
  getQuery(): Readonly<Record<string, string>>
  Control?: ComponentType
  Empty?: ComponentType<{ className?: string }>
}

/** The whole app while a server with account sign-in has no account yet, so its first-time setup is open. */
export interface SetupScreenProps {
  /** Setup signed the caller in. */
  onAuthenticated(): void
  /** Setup closed, by this caller or another: re-reads the server's handshake. */
  onSetupClosed(): Promise<void>
}

/** The whole app while the server keeps the caller out; `gate` is the server's opaque reason. */
export interface GateScreenProps {
  gate: string
  /** The server lets the caller in again. */
  onRestored(): void
  onLogout(): void
}

/** The signed-in account in the app's header, and the way to sign out. */
export interface AccountControlProps {
  onLogout(): void
  /** Opens one of the edition's main views by id. */
  onOpenMainView(id: string): void
  /** Touch-sized, for the mobile header. */
  mobile?: boolean
  className?: string
}

export interface EditionUi {
  SetupScreen?: ComponentType<SetupScreenProps>
  /** Under the sign-in form of a server with accounts. */
  LoginNotice?: ComponentType
  GateScreen?: ComponentType<GateScreenProps>
  AccountControl?: ComponentType<AccountControlProps>
  /** In the open session's header, beside core's own session actions; not for a sub-agent view. */
  SessionHeaderActions?: ComponentType<{ sessionId: string }>
  /** Beside a session in every session list; `access` is what the row carries, which an edition may extend. */
  SessionBadges?: ComponentType<{ access: ListedAccess | undefined }>
  /** Stands for "View only" under a session the user can read but not drive. */
  ReadOnlyNote?: ComponentType<{ sessionId: string }>
  mainViews?: readonly EditionMainView[]
  sessionListFilter?: SessionListFilter
  onInboxRead?(inbox: readonly CogpitNotification[]): void
}

/** What `@cogpit/edition-ui` exports by default: the UI, and the edition it belongs to. */
export interface EditionUiModule {
  edition: Exclude<CogpitEdition, "personal">
  ui: EditionUi
}
