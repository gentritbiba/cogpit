// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * Where the memory store lives. The server and the CLI both resolve it here;
 * the server passes the result to every agent it starts, because a provider
 * worker runs with a different HOME.
 */
export const MEMORY_DIR_ENV = "COGPIT_MEMORY_DIR"
export const MEMORY_DATABASE_FILE = "memory.db"

export function resolveMemoryDir(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  return env[MEMORY_DIR_ENV]?.trim() || joinPath(homeDir, ".cogpit", "memory")
}

export function memoryDatabasePath(memoryDir: string): string {
  return joinPath(memoryDir, MEMORY_DATABASE_FILE)
}

function joinPath(base: string, ...parts: string[]): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/"
  return [base.replace(/[\\/]+$/, ""), ...parts].join(separator)
}
