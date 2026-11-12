import { existsSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const CORE_BINARY_NAME = process.platform === "win32" ? "cogpit-core.exe" : "cogpit-core"

export class CoreBinaryMissingError extends Error {
  constructor(detail: string) {
    super(
      `Cogpit cannot start: the cogpit-core binary was not found (${detail}). `
      + "Build it with `bun run build:core` (needs the Rust toolchain from https://rustup.rs) "
      + "or point COGPIT_CORE_BIN at it.",
    )
    this.name = "CoreBinaryMissingError"
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The checkout holding this module, found by walking up to the Cargo
 * workspace. Server code runs from the source tree and from the npm bundle
 * in `packages/cogpit-cli/dist`, so no fixed relative path reaches the
 * repository root from both.
 */
function findWorkspaceRoot(start: string): string | null {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, "crates", "cogpit-core", "Cargo.toml"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The newest of a checkout's debug and release builds. */
function newestDevBuild(targetDir: string): string | null {
  const builds = ["debug", "release"]
    .map((profile) => join(targetDir, profile, CORE_BINARY_NAME))
    .filter(isFile)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return builds[0] ?? null
}

export interface ResolveCoreBinaryOptions {
  /** Packaged location supplied by the shell (`AppServerEnvironment.coreBin`). */
  configured?: string
  env?: NodeJS.ProcessEnv
  /** Where to start looking for a checkout; defaults to this module's directory. */
  from?: string
}

/** `COGPIT_CORE_BIN`, then the shell's packaged path, then a dev build in the checkout. */
export function resolveCoreBinary({
  configured,
  env = process.env,
  from = dirname(fileURLToPath(import.meta.url)),
}: ResolveCoreBinaryOptions = {}): string {
  const explicit = env.COGPIT_CORE_BIN?.trim()
  if (explicit) {
    if (!isFile(explicit)) throw new CoreBinaryMissingError(`COGPIT_CORE_BIN=${explicit} is not a file`)
    return resolve(explicit)
  }
  if (configured) {
    if (!isFile(configured)) throw new CoreBinaryMissingError(`${configured} is not a file`)
    return resolve(configured)
  }
  const root = findWorkspaceRoot(from)
  if (!root) throw new CoreBinaryMissingError("no packaged binary and no Cargo workspace above the server")
  const targetDir = env.CARGO_TARGET_DIR?.trim() ? resolve(env.CARGO_TARGET_DIR) : join(root, "target")
  const build = newestDevBuild(targetDir)
  if (!build) throw new CoreBinaryMissingError(`nothing built under ${targetDir}`)
  return build
}
