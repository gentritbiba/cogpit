import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"

type FileRequestPath =
  | { ok: true; filePath: string }
  | { ok: false; statusCode: 400; error: string }

type ReadableFileValidation =
  | { ok: true }
  | { ok: false; statusCode: 404 | 413; error: string }

/**
 * Resolve the shared `?path=` contract used by local file routes.
 */
export function resolveFileRequestPath(
  requestUrl: string | undefined,
): FileRequestPath {
  const url = new URL(requestUrl || "", "http://localhost")
  const filePath = url.searchParams.get("path")

  if (!filePath) {
    return { ok: false, statusCode: 400, error: "path query parameter required" }
  }

  if (!isAbsolute(filePath)) {
    return { ok: false, statusCode: 400, error: "path must be absolute" }
  }

  return { ok: true, filePath }
}

/** Validate file existence, kind, and the endpoint-specific size ceiling. */
export async function validateReadableFile(
  filePath: string,
  maxFileSize: number,
): Promise<ReadableFileValidation> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return { ok: false, statusCode: 404, error: "Not a file" }
    }
    if (info.size > maxFileSize) {
      return { ok: false, statusCode: 413, error: "File too large" }
    }
  } catch {
    return { ok: false, statusCode: 404, error: "File not found" }
  }

  return { ok: true }
}
