/**
 * Cross-platform resolution of agent CLIs (`claude`, `codex`) to something
 * `child_process` can actually launch.
 *
 * On Windows these CLIs are usually npm shims — `claude.cmd` — and
 * CreateProcess only ever appends `.exe`/`.com`, so a bare `spawn("claude")`
 * fails with ENOENT. A `.cmd` is a batch file, which only cmd.exe can run, so
 * the resolver returns the cmd.exe invocation (arguments included) rather than
 * a command name the caller has to wrap correctly on its own.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs"
import { posix, win32 } from "node:path"

/** Extensions CreateProcess launches directly; everything else needs cmd.exe. */
const DIRECT_EXTENSIONS = [".exe", ".com"]

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"

/**
 * cmd.exe re-parses the line before the batch file (and the program behind it)
 * ever sees it, so every character it treats specially is caret-escaped.
 * `shell: true` is deliberately not used: Node builds its shell command line by
 * joining argv with spaces and no escaping at all, which shreds any argument
 * containing whitespace or quotes — and user messages are passed as argv.
 */
const CMD_META_CHARS = /([()[\]%!^"`<>&|;, *?])/g

export interface ResolveEnvironment {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Injected by tests; defaults to a real filesystem probe. */
  isExecutable?: (candidate: string) => boolean
}

export interface ResolvedCommand {
  command: string
  args: string[]
  /** Spawn options the caller must spread into its spawn()/execFile() call. */
  spawnOptions: { windowsVerbatimArguments?: boolean }
}

function isWindows(env: ResolveEnvironment): boolean {
  return (env.platform ?? process.platform) === "win32"
}

function probeExecutable(env: ResolveEnvironment): (candidate: string) => boolean {
  if (env.isExecutable) return env.isExecutable
  if (isWindows(env)) {
    // accessSync(X_OK) degrades to a plain existence check on Windows, where
    // launchability comes from the extension, not from a permission bit.
    return (candidate) => {
      try {
        return statSync(candidate).isFile()
      } catch {
        return false
      }
    }
  }
  return (candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
}

/** PATHEXT is conventionally upper case; the files it matches are not. */
function pathExtensions(env: ResolveEnvironment): string[] {
  const raw = (env.env ?? process.env).PATHEXT ?? DEFAULT_PATHEXT
  return raw.split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean)
}

function hasExtension(binName: string, extensions: string[]): boolean {
  return extensions.includes(win32.extname(binName).toLowerCase())
}

export interface FindOptions extends ResolveEnvironment {
  /** Only accept binaries the OS can launch without cmd.exe (Windows only). */
  directOnly?: boolean
}

/** First executable named `binName` on PATH, if any. */
export function findExecutableOnPath(binName: string, options: FindOptions = {}): string | undefined {
  const windows = isWindows(options)
  const path = windows ? win32 : posix
  const isExecutable = probeExecutable(options)
  const dirs = ((options.env ?? process.env).PATH ?? "").split(path.delimiter)

  let names = [binName]
  if (windows) {
    const extensions = options.directOnly ? DIRECT_EXTENSIONS : pathExtensions(options)
    if (!hasExtension(binName, extensions)) {
      names = extensions.map((ext) => binName + ext)
      // A bare name is not launchable by CreateProcess, but it is still a valid
      // cmd.exe target (npm ships an extensionless shell script beside the shim).
      if (!options.directOnly) names.push(binName)
    }
  }

  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Quote one argument the way the C runtime parses argv back out, so the CLI
 * receives it verbatim.
 */
function quoteArgument(arg: string): string {
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1")
  return `"${escaped}"`
}

function escapeForCmd(text: string): string {
  return text.replace(CMD_META_CHARS, "^$1")
}

function throughCmdExe(
  executable: string,
  args: string[],
  options: ResolveEnvironment,
): ResolvedCommand {
  const line = [
    escapeForCmd(executable),
    ...args.map((arg) => escapeForCmd(quoteArgument(arg))),
  ].join(" ")
  return {
    command: (options.env ?? process.env).COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    spawnOptions: { windowsVerbatimArguments: true },
  }
}

/**
 * Resolve an agent CLI plus its arguments into a ready-to-spawn triple.
 *
 * ```ts
 * const cli = resolveAgentCommand("codex", ["exec", "--json", message])
 * spawn(cli.command, cli.args, { cwd, env, ...cli.spawnOptions })
 * ```
 *
 * Outside Windows this is the pre-existing behaviour: spawn the bare name and
 * let the OS walk PATH.
 */
export function resolveAgentCommand(
  binName: string,
  args: string[] = [],
  options: ResolveEnvironment = {},
): ResolvedCommand {
  if (!isWindows(options)) return { command: binName, args, spawnOptions: {} }

  const resolved = /[\\/]/.test(binName)
    ? binName
    : findExecutableOnPath(binName, options)
  // Nothing on PATH: keep the bare name so the caller still gets the ENOENT it
  // already knows how to report.
  if (!resolved) return { command: binName, args, spawnOptions: {} }
  if (DIRECT_EXTENSIONS.includes(win32.extname(resolved).toLowerCase())) {
    return { command: resolved, args, spawnOptions: {} }
  }
  return throughCmdExe(resolved, args, options)
}

/** Name a platform-specific package uses for its vendored native binary. */
export function nativeBinaryName(base: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${base}.exe` : base
}
