/**
 * Status-dot classes shared by the live-session lists.
 *
 * `animate-pulse` / `animate-ping` are globally disabled (see index.css) to keep
 * Chromium's compositor idle, so each state has to be legible from a static
 * paint: brightness and halo, not motion.
 */
export const STATUS_DOT = {
  /** Blocked on a human — permission prompt, question, deferred decision. */
  attention: "bg-amber-400",
  /** The agent is producing output right now. */
  working: "bg-green-400 ring-2 ring-green-400/40",
  /** Live session whose agent is waiting for the next instruction. */
  idle: "bg-green-400/40",
} as const
