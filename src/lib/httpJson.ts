export async function readJson(res: Response | null): Promise<Record<string, unknown> | null> {
  try {
    const data = (await res?.json()) as unknown
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The route's `{ error }` message, or a caller-supplied fallback. */
export async function readError(res: Response | null, fallback: string): Promise<string> {
  const data = await readJson(res)
  return typeof data?.error === "string" && data.error ? data.error : fallback
}
