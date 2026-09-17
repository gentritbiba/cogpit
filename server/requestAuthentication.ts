import type { IncomingMessage } from "node:http"
import type { SessionPrincipal } from "./team/constants"

export type RequestAuthentication =
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "session"; token: string; principal: Readonly<SessionPrincipal> | null }>

const authenticated = new WeakMap<IncomingMessage, RequestAuthentication>()

export function setRequestAuthentication(req: IncomingMessage, authentication: RequestAuthentication): void {
  authenticated.set(req, authentication.kind === "local"
    ? Object.freeze({ kind: "local" })
    : Object.freeze({ ...authentication, principal: authentication.principal ? Object.freeze({ ...authentication.principal }) : null }))
}

export function clearRequestAuthentication(req: IncomingMessage): void {
  authenticated.delete(req)
}

export function getRequestAuthentication(req: IncomingMessage): RequestAuthentication | null {
  return authenticated.get(req) ?? null
}
