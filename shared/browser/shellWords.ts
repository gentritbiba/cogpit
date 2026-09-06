export interface ShellWord {
  value: string
  start: number
  end: number
  literal: boolean
}

export interface ShellCommand {
  words: ShellWord[]
  end: number
  pipeline: number
}

function readWord(source: string, start: number): ShellWord | null {
  let value = ""
  let quote = ""
  let literal = true
  let index = start
  for (; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (!quote && /[\s;&|()<>]/.test(char)) break
    if (char === "\\" && quote !== "'") {
      if (next === undefined) return null
      if (!quote || /[$`"\\\n]/.test(next)) {
        if (next !== "\n") value += next
        index++
        continue
      }
    }
    if (char === quote) {
      quote = ""
      continue
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char
      continue
    }
    if (quote !== "'") {
      if (char === "`" || (char === "$" && /[('"{]/.test(next ?? ""))) return null
      if (char === "$" || (!quote && /[*?[{}~]/.test(char))) literal = false
    }
    value += char
  }
  return quote ? null : { value, start, end: index, literal }
}

/** A bounded shell lexer: unsupported expansions and heredocs are never edited. */
export function readShellCommands(source: string): { commands: ShellCommand[]; complete: boolean } {
  const commands: ShellCommand[] = []
  let words: ShellWord[] = []
  let pipeline = 0
  let depth = 0
  const incomplete = () => ({ commands: [...commands, { words, end: source.length, pipeline }], complete: false })
  for (let index = 0; index < source.length;) {
    const char = source[index]
    if (char === "\\" && source[index + 1] === "\n") {
      index += 2
      continue
    }
    if (char === "#") {
      const newline = source.indexOf("\n", index)
      commands.push({ words, end: index, pipeline })
      if (words.length > 0 && depth === 0) pipeline++
      words = []
      index = newline < 0 ? source.length : newline
      continue
    }
    if (/[^\S\n]/.test(char)) {
      index++
      continue
    }
    if (/[;&|()\n]/.test(char)) {
      const next = source[index + 1]
      const pipe = char === "|" && next !== "|"
      if (char === "(") depth++
      if (char === ")") depth--
      if (depth < 0) return incomplete()
      commands.push({ words, end: index, pipeline })
      // Commands in a subshell can all feed the same outer pipe.
      if (depth === 0 && !pipe && char !== "(" && char !== ")" && (char !== "\n" || words.length > 0)) pipeline++
      words = []
      index += ((char === "&" || char === "|") && (next === char || (pipe && next === "&"))) ? 2 : 1
      continue
    }
    if (/^(?:\d+)?<</.test(source.slice(index))) return incomplete()
    const redirect = /^(?:\d+)?(?:>>|>\||>&|<&|<>|[<>])/.exec(source.slice(index))
    if (redirect) {
      index += redirect[0].length
      while (/[^\S\n]/.test(source[index] ?? "")) index++
      const target = readWord(source, index)
      if (!target || target.end === index) return incomplete()
      index = target.end
      continue
    }
    const word = readWord(source, index)
    if (!word || word.end === index) return incomplete()
    words.push(word)
    index = word.end
  }
  commands.push({ words, end: source.length, pipeline })
  return { commands, complete: depth === 0 }
}
