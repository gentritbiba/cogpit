import { homedir } from "node:os"
import { resolveMemoryDir } from "../../shared/memory/paths"

/** The memory store directory the server and every agent it starts share. */
export function memoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveMemoryDir(env, homedir())
}
