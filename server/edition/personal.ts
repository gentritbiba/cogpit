import { ALL_CAPABILITIES, type MeResponse } from "../../shared/contracts/identity"
import { descriptorForDirName } from "../../shared/session/agent-descriptors"
import type { AuthorizedSession, EditionModule, SessionRef, VisibilityCheck, VisibleSession } from "./types"

/**
 * Personal edition: one trusted owner, so every hook answers without a check,
 * a store or any I/O. This is what runs until an edition is installed.
 */

const PERSONAL_ME: MeResponse = Object.freeze({
  authenticated: true,
  edition: "personal",
  user: null,
  capabilities: ALL_CAPABILITIES,
})

const UNCHANGED: VisibleSession = { annotate: async (item) => item }
const EVERYTHING_VISIBLE: VisibilityCheck = Object.assign(async (): Promise<VisibleSession> => UNCHANGED, {
  everything: true,
  nothing: false,
})

/**
 * Checking nothing and touching no file, personal edition answers with the
 * session the ref spells: the bare id exactly as given, else the root session
 * its file name reads as (the file name itself when it reads as none).
 */
function spelledSession(ref: SessionRef): AuthorizedSession {
  if ("sessionId" in ref) return { sessionId: ref.sessionId, filePath: null, isRootTranscript: true }
  const root = descriptorForDirName(ref.dirName).sessionFile.transcriptRoot(ref.fileName)
  return { sessionId: root?.rootSessionId ?? ref.fileName, filePath: null, isRootTranscript: root?.isRootTranscript ?? false }
}

const nothing = (): void => {}

export const PERSONAL_EDITION: EditionModule = {
  edition: "personal",
  boot: async () => {},
  flush: async () => {},
  auth: null,
  authorize: (_req, _res, next) => next(),
  hubProxyRejection: () => null,
  me: () => PERSONAL_ME,
  setupRequired: () => false,
  unguardedApiPaths: [],
  bootNotices: () => [],
  registerRoutes: nothing,
  access: {
    authorizeSession: async (_req, _res, ref) => spelledSession(ref),
    levelOf: async () => "own",
    visibilityFor: () => EVERYTHING_VISIBLE,
    parseScope: () => "all",
    markDecided: nothing,
    recordSessionOwner: nothing,
    removeSessionAccess: async () => {},
    observeAgentTeam: async () => {},
    announceSessionConfig: nothing,
  },
  activity: {
    reportSessionEvent: nothing,
    reportAuthEvent: nothing,
    reportShareEvent: nothing,
    reportShareLogin: nothing,
  },
  // Every agent opens the host's own `default`, as it always has.
  browsers: {
    profileForSession: () => null,
    profileForCaller: () => null,
    reservesName: () => false,
    accountOf: () => null,
  },
  turns: {
    start: (_req, _receivedAt, runtime, request) => runtime.start(request),
    send: (_req, runtime, sessionId, request) => runtime.send(sessionId, request),
    hand: (_req, _prompt, deliver) => deliver(),
  },
  sessionSettings: {
    settleTurn: async (_req, _session, request) => request,
    holdLiveUpdate: (updates) => updates,
    storeApplied: async () => {},
    onConfigWrite: async () => {},
  },
  notificationRetention: { hostEntries: 200, persistDelayMs: 500 },
}
