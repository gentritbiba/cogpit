// ── Gate signal ─────────────────────────────────────────────────────────
//
// While a server keeps the caller out of everything but what can let them back
// in, it refuses every other request with a 403 naming its reason in
// GATE_HEADER. Each such refusal becomes one window event, on which the
// identity is read again so the app gives way to the gate screen.

import { GATE_HEADER } from "../../shared/contracts/identity"

const GATE_EVENT = "cogpit-gate"

/** Announce a request the server refused behind its gate; any other response says nothing. */
export function announceGate(res: Response): void {
  if (res.status === 403 && res.headers.has(GATE_HEADER)) {
    window.dispatchEvent(new Event(GATE_EVENT))
  }
}

/** Call `listener` on each request the server refuses behind its gate. Returns the stop. */
export function onGate(listener: () => void): () => void {
  window.addEventListener(GATE_EVENT, listener)
  return () => window.removeEventListener(GATE_EVENT, listener)
}
