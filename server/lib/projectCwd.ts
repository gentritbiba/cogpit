import { descriptorForDirName } from "../../shared/session/agent-descriptors"
import { join, open, readdir } from "../helpers"

const HEADER_BYTES = 8192

/** The `cwd` recorded in a transcript's header, or null if it has none. */
async function cwdFromTranscript(path: string): Promise<string | null> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    for (const line of buffer.subarray(0, bytesRead).toString("utf-8").split("\n")) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.cwd) return parsed.cwd
      } catch {
        continue
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Recover the project path a session runs in.
 *
 * Only an agent whose dirName is a lossy encoding of the cwd needs the
 * transcript read; the others decode their dirName exactly.
 */
export async function resolveProjectCwd(
  projectDir: string,
  dirName: string,
): Promise<string | null> {
  const files = await readdir(projectDir).catch(() => [])
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue
    const cwd = await cwdFromTranscript(join(projectDir, file)).catch(() => null)
    if (cwd) return cwd
  }
  return descriptorForDirName(dirName).dirName.decode(dirName)
}
