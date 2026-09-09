import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** True when the file on disk already holds exactly this content. */
export function hasContent(path: string, content: string): boolean {
  try {
    return readFileSync(path, "utf8") === content
  } catch {
    return false
  }
}

/** Atomic tmp+rename, skipped when the content already matches; `mode` is re-applied either way. */
export function writeIfChanged(path: string, content: string, mode?: number): void {
  if (!hasContent(path, content)) {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
    renameSync(tmp, path)
  }
  if (mode !== undefined) chmodSync(path, mode)
}
