import { authFetch, type AuthFetchInit } from "@/lib/auth"

export type Conditional<T> =
  | { kind: "unchanged" }
  | { kind: "changed"; value: T; etag: string | null }
  | { kind: "failed"; status: number }

/**
 * A GET that sends the ETag of the copy the caller holds: `unchanged` when the
 * server answers 304, so a poll of something that did not change costs no body
 * and no parse. Older servers send no ETag and always answer `changed`.
 */
export async function fetchIfChanged<T>(url: string, etag: string | null, init: AuthFetchInit = {}): Promise<Conditional<T>> {
  const headers = new Headers(init.headers)
  if (etag) headers.set("If-None-Match", etag)
  const response = await authFetch(url, { ...init, headers, cache: "no-store" })
  if (response.status === 304) return { kind: "unchanged" }
  if (!response.ok) return { kind: "failed", status: response.status }
  return { kind: "changed", value: await response.json() as T, etag: response.headers.get("ETag") }
}
