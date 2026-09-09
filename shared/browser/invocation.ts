import { DEFAULT_BROWSER, isValidBrowserName } from "./names"
import { readShellCommands, type ShellWord } from "./shellWords"

export const BROWSER_BINARY = "agent-browser"

export interface BrowserInvocation {
  text: string
  /** Past the entire executable word, including any closing quote. */
  binaryEnd: number
  browser: string
  sessionFlag: { start: number; end: number } | null
}

export interface BrowserInvocationScan {
  invocations: BrowserInvocation[]
  /** Possible browser execution that cannot be safely rewritten. */
  ambiguous: boolean
}

const LAUNCHERS = new Map<string, Set<string>>([
  ["env", new Set(["-i", "--ignore-environment", "--"])],
  ["command", new Set(["--"])],
  ["exec", new Set(["--"])],
  ["npx", new Set(["-y", "--yes", "--"])],
  ["bunx", new Set(["--bun", "--"])],
])
const DATA_COMMANDS = new Set([
  "echo", "printf", "rg", "grep", "cat", "head", "tail", "wc", "ls", "stat", "file",
  "basename", "dirname", "cp", "mv", "rm", "mkdir", "rmdir", "touch",
])
const GIT_DATA_COMMANDS = new Set(["commit", "log", "show", "diff", "status", "add", "grep", "ls-files", "rev-parse"])
const COMPOUND_COMMAND = /^(?:if|then|else|elif|fi|while|until|for|select|case|esac|do|done|function|\{|\}|!)$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z_\d]*=/

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1)
}

/** null means an unsupported launcher; -1 means there is no executed command. */
function executableIndex(words: ShellWord[], source: string): number | null {
  let index = 0
  while (index < words.length) {
    const word = words[index]
    if (ASSIGNMENT.test(source.slice(word.start, word.end))) {
      index++
      continue
    }
    if (!word.literal || COMPOUND_COMMAND.test(word.value)) return null
    const name = basename(word.value)
    if (name === "command" && ["-v", "-V"].includes(words[index + 1]?.value)) return -1
    const flags = LAUNCHERS.get(name)
    if (!flags) return index
    index++
    while (words[index]?.value.startsWith("-")) {
      if (!words[index].literal || !flags.has(words[index].value)) return null
      const endOfOptions = words[index++].value === "--"
      if (endOfOptions) break
    }
  }
  return -1
}

function invocationOf(words: ShellWord[], end: number, source: string): BrowserInvocation | null {
  const [binary, ...args] = words
  if (args.some((word) => !word.literal)) return null
  let browser = DEFAULT_BROWSER
  let sessionFlag: BrowserInvocation["sessionFlag"] = null
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag.value !== "--session" && !flag.value.startsWith("--session=")) continue
    if (sessionFlag !== null) return null
    const value = flag.value === "--session" ? args[++index] : flag
    browser = flag.value === "--session" ? value?.value : flag.value.slice("--session=".length)
    if (!browser || !isValidBrowserName(browser)) return null
    if (value !== flag && !/^(?:\s|\\\n)*$/.test(source.slice(flag.end, value.start))) return null
    sessionFlag = { start: flag.start, end: value.end }
  }
  return {
    text: BROWSER_BINARY + source.slice(binary.end, end).trimEnd(),
    binaryEnd: binary.end,
    browser,
    sessionFlag,
  }
}

/** Shared by the pre-tool guard and the transcript's Browser panel captions. */
export function scanBrowserInvocations(command: string): BrowserInvocationScan {
  const { commands, complete } = readShellCommands(command)
  const invocations: BrowserInvocation[] = []
  const mentionsBrowser = commands.some(({ words }) => words.some(({ value }) => value.includes(BROWSER_BINARY)))
  if (!complete) return { invocations, ambiguous: mentionsBrowser || command.includes(BROWSER_BINARY) }
  const browserPipelines = new Set(commands
    .filter(({ words }) => words.some(({ value }) => value.includes(BROWSER_BINARY)))
    .map(({ pipeline }) => pipeline))
  let ambiguous = false
  for (const { words, end, pipeline } of commands) {
    const index = executableIndex(words, command)
    if (index === null) {
      ambiguous ||= mentionsBrowser
      continue
    }
    if (index < 0) continue
    const name = basename(words[index].value)
    if (name !== BROWSER_BINARY) {
      const dataCommand = DATA_COMMANDS.has(name)
        || (name === "git" && GIT_DATA_COMMANDS.has(words[index + 1]?.value))
      if (!dataCommand && browserPipelines.has(pipeline)) ambiguous = true
      continue
    }
    const invocation = invocationOf(words.slice(index), end, command)
    if (invocation === null) ambiguous = true
    else invocations.push(invocation)
  }
  return { invocations, ambiguous }
}

export function findBrowserInvocations(command: string): BrowserInvocation[] {
  return scanBrowserInvocations(command).invocations
}
