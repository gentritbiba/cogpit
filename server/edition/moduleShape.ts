import type {
  EditionActivity,
  EditionAuth,
  EditionBrowsers,
  EditionModule,
  EditionSessionAccess,
  EditionSessionSettings,
  EditionTurns,
  NotificationRetention,
  PersistentSessionStore,
} from "./types"

/**
 * The members an installed edition must carry. The team package versions
 * apart from core, so one built against another core is refused at load,
 * before a request or shutdown would reach the member it lacks.
 */

type Member = "function" | "strings" | "number" | { readonly [name: string]: Member }

const SESSION_STORE = {
  persist: "function",
  restore: "function",
  touch: "function",
  remove: "function",
  removeForUser: "function",
  clear: "function",
  flush: "function",
} as const satisfies Record<keyof PersistentSessionStore, Member>

const AUTH = {
  middleware: "function",
  login: "function",
  admitsSocket: "function",
  administers: "function",
  sessions: SESSION_STORE,
} as const satisfies Record<keyof EditionAuth, Member>

const ACCESS = {
  authorizeSession: "function",
  levelOf: "function",
  visibilityFor: "function",
  parseScope: "function",
  markDecided: "function",
  recordSessionOwner: "function",
  removeSessionAccess: "function",
  observeAgentTeam: "function",
  announceSessionConfig: "function",
} as const satisfies Record<keyof EditionSessionAccess, Member>

const ACTIVITY = {
  reportSessionEvent: "function",
  reportAuthEvent: "function",
  reportShareEvent: "function",
  reportShareLogin: "function",
} as const satisfies Record<keyof EditionActivity, Member>

const TURNS = {
  start: "function",
  send: "function",
  hand: "function",
} as const satisfies Record<keyof EditionTurns, Member>

const SESSION_SETTINGS = {
  settleTurn: "function",
  holdLiveUpdate: "function",
  storeApplied: "function",
  onConfigWrite: "function",
} as const satisfies Record<keyof EditionSessionSettings, Member>

const NOTIFICATION_RETENTION = {
  hostEntries: "number",
  persistDelayMs: "number",
} as const satisfies Record<keyof NotificationRetention, Member>

const BROWSERS = {
  profileForSession: "function",
  profileForCaller: "function",
  reservesName: "function",
  accountOf: "function",
} as const satisfies Record<keyof EditionBrowsers, Member>

/** `edition` is how the loader picks a module, and `auth` may be null. */
const MODULE = {
  boot: "function",
  flush: "function",
  authorize: "function",
  hubProxyRejection: "function",
  me: "function",
  setupRequired: "function",
  unguardedApiPaths: "strings",
  bootNotices: "function",
  registerRoutes: "function",
  access: ACCESS,
  activity: ACTIVITY,
  browsers: BROWSERS,
  turns: TURNS,
  sessionSettings: SESSION_SETTINGS,
  notificationRetention: NOTIFICATION_RETENTION,
} as const satisfies Record<Exclude<keyof EditionModule, "edition" | "auth">, Member>

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function missingMembers(value: unknown, shape: { readonly [name: string]: Member }, path: string): string[] {
  if (typeof value !== "object" || value === null) return [path]
  const members = value as Record<string, unknown>
  return Object.entries(shape).flatMap(([name, member]) => {
    const at = path ? `${path}.${name}` : name
    if (member === "function") return typeof members[name] === "function" ? [] : [at]
    if (member === "strings") return isStringList(members[name]) ? [] : [at]
    if (member === "number") return Number.isFinite(members[name]) ? [] : [at]
    return missingMembers(members[name], member, at)
  })
}

/** What `candidate` lacks of an edition module, as dotted member paths; empty when it has everything. */
export function missingEditionMembers(candidate: object): string[] {
  const missing = missingMembers(candidate, MODULE, "")
  if (!("auth" in candidate)) return [...missing, "auth"]
  return candidate.auth === null ? missing : [...missing, ...missingMembers(candidate.auth, AUTH, "auth")]
}
