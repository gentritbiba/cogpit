import { useSyncExternalStore } from "react"
import { authFetch } from "@/lib/auth"
import type { ListedBoard } from "../../shared/contracts/board"

const POLL_INTERVAL = 5_000
const NO_BOARDS: ReadonlyMap<string, ListedBoard> = new Map()

let boards = NO_BOARDS
let received = "[]"
/** Bumped when the device scope changes, so an answer from the previous device is dropped. */
let generation = 0
let inFlight: number | null = null
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function publish(next: ReadonlyMap<string, ListedBoard>): void {
  boards = next
  for (const listener of listeners) listener()
}

async function refresh(): Promise<void> {
  if (inFlight === generation || document.visibilityState !== "visible") return
  const requested = generation
  inFlight = requested
  try {
    const response = await authFetch("/api/session-boards")
    if (requested !== generation || !response.ok) return
    const { boards: listed } = await response.json() as { boards: ListedBoard[] }
    if (requested !== generation) return
    const text = JSON.stringify(listed)
    if (text === received || listeners.size === 0) return
    received = text
    publish(new Map(listed.map((board) => [board.sessionId, board])))
  } catch {
    // The next poll retries.
  } finally {
    if (inFlight === requested) inFlight = null
  }
}

function forgetDevice(): void {
  generation += 1
  received = "[]"
  publish(NO_BOARDS)
  void refresh()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    void refresh()
    timer = setInterval(refresh, POLL_INTERVAL)
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener("cogpit-device-scope-changed", forgetDevice)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    if (timer) clearInterval(timer)
    timer = null
    document.removeEventListener("visibilitychange", refresh)
    window.removeEventListener("cogpit-device-scope-changed", forgetDevice)
  }
}

/**
 * Every board the caller may see, by the session that keeps it, the most
 * recently updated first. One poll serves every component that asks.
 */
export function useSessionBoards(): ReadonlyMap<string, ListedBoard> {
  return useSyncExternalStore(subscribe, () => boards)
}

export function __resetSessionBoardsForTest(): void {
  boards = NO_BOARDS
  received = "[]"
  generation = 0
  inFlight = null
}
