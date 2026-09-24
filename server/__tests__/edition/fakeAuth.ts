import { vi } from "vitest"
import type { PersistentSessionStore, RestoredSession } from "../../edition"
import type { SessionPrincipal } from "../../sessionConstants"

/** Persisted logins in memory, keyed by token, as an edition's store would keep them. */
function fakeSessionStore() {
  const rows = new Map<string, RestoredSession>()
  const store = {
    persist: vi.fn(async (token: string, principal: RestoredSession["principal"], createdAt: number) => {
      rows.set(token, { createdAt, lastActivity: createdAt, principal })
    }),
    restore: vi.fn((token: string) => rows.get(token) ?? null),
    touch: vi.fn(async (token: string, lastActivity: number) => {
      const row = rows.get(token)
      if (row) rows.set(token, { ...row, lastActivity })
    }),
    remove: vi.fn(async (token: string) => {
      rows.delete(token)
    }),
    removeForUser: vi.fn(async (userId: string) => {
      for (const [token, row] of rows) if (row.principal?.userId === userId) rows.delete(token)
    }),
    clear: vi.fn(async () => rows.clear()),
    flush: vi.fn(async () => {}),
  } satisfies PersistentSessionStore
  return Object.assign(store, { rows })
}

/**
 * An edition's sign-in: a middleware, login and socket check that only record
 * their calls, over `fakeSessionStore()`. It administers for a principal whose
 * role is `admin`.
 */
export function fakeEditionAuth() {
  return {
    middleware: vi.fn(),
    login: vi.fn(async () => {}),
    admitsSocket: vi.fn(() => true),
    administers: vi.fn((principal: SessionPrincipal) => principal.role === "admin"),
    sessions: fakeSessionStore(),
  }
}
