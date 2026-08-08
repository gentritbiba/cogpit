// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.

export interface JsStringLiteral {
  endIndex: number
  value: string
}

export interface CodexExecInvocation {
  name: string
  argumentSource: string
  startIndex: number
}

const JS_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_$]/.test(char))
}

function isIdentifierPart(char: string | undefined): boolean {
  return Boolean(char && /[\w$]/.test(char))
}

export function readJsStringLiteral(source: string, startIndex: number): JsStringLiteral | null {
  const quote = source[startIndex]
  if (quote !== '"' && quote !== "'" && quote !== "`") return null

  let value = ""
  let index = startIndex + 1
  while (index < source.length) {
    const char = source[index]
    if (char === quote) return { endIndex: index + 1, value }
    if (char !== "\\") {
      value += char
      index++
      continue
    }

    index++
    if (index >= source.length) return null
    const escaped = source[index]
    if (escaped in JS_SIMPLE_ESCAPES) {
      value += JS_SIMPLE_ESCAPES[escaped]
      index++
      continue
    }
    if (escaped === "\n") {
      index++
      continue
    }
    if (escaped === "\r") {
      index += source[index + 1] === "\n" ? 2 : 1
      continue
    }
    if (escaped === "x" && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 1, index + 3))) {
      value += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 3), 16))
      index += 3
      continue
    }
    if (escaped === "u") {
      const braced = source.slice(index + 1).match(/^\{([0-9a-fA-F]+)\}/)
      if (braced) {
        const codePoint = Number.parseInt(braced[1], 16)
        if (Number.isFinite(codePoint) && codePoint <= 0x10ffff) {
          value += String.fromCodePoint(codePoint)
          index += braced[0].length + 1
          continue
        }
      }
      const hex = source.slice(index + 1, index + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16))
        index += 5
        continue
      }
    }

    value += escaped
    index++
  }

  return null
}

const CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" }

function skipComment(source: string, startIndex: number): number | null {
  if (source[startIndex] !== "/") return null
  if (source[startIndex + 1] === "/") {
    const newline = source.indexOf("\n", startIndex + 2)
    return newline === -1 ? source.length : newline + 1
  }
  if (source[startIndex + 1] === "*") {
    const close = source.indexOf("*/", startIndex + 2)
    return close === -1 ? source.length : close + 2
  }
  return null
}

/** Advance past a string literal or a comment; null when the position is neither. */
function skipStringOrComment(
  source: string,
  startIndex: number,
): { endIndex: number; isString: boolean } | null {
  const literal = readJsStringLiteral(source, startIndex)
  if (literal) return { endIndex: literal.endIndex, isString: true }
  const afterComment = skipComment(source, startIndex)
  return afterComment === null ? null : { endIndex: afterComment, isString: false }
}

function skipTrivia(source: string, startIndex: number): number {
  let index = startIndex
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index++
      continue
    }
    const afterComment = skipComment(source, index)
    if (afterComment === null) break
    index = afterComment
  }
  return index
}

function findMatchingDelimiter(source: string, openIndex: number): number | null {
  const first = source[openIndex]
  if (!CLOSERS[first]) return null

  const stack = [CLOSERS[first]]
  for (let index = openIndex + 1; index < source.length; index++) {
    const skipped = skipStringOrComment(source, index)
    if (skipped) {
      index = skipped.endIndex - 1
      continue
    }

    const char = source[index]
    if (CLOSERS[char]) {
      stack.push(CLOSERS[char])
      continue
    }
    if (char !== stack.at(-1)) continue
    stack.pop()
    if (stack.length === 0) return index
  }
  return null
}

function readIdentifier(source: string, startIndex: number): JsStringLiteral | null {
  if (!isIdentifierStart(source[startIndex])) return null
  let endIndex = startIndex + 1
  while (isIdentifierPart(source[endIndex])) endIndex++
  return { value: source.slice(startIndex, endIndex), endIndex }
}

function resolveAssignedArgument(source: string, invocationStart: number, argumentSource: string): string {
  const identifier = argumentSource.trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1]
  if (!identifier) return argumentSource

  const prefix = source.slice(0, invocationStart)
  const assignment = new RegExp(`\\b(?:const|let|var)\\s+${identifier.replace(/[$]/g, "\\$")}\\s*=`, "g")
  const lastMatch = [...prefix.matchAll(assignment)].at(-1)
  if (!lastMatch || lastMatch.index === undefined) return argumentSource

  const valueStart = skipTrivia(prefix, lastMatch.index + lastMatch[0].length)
  const opening = prefix[valueStart]
  if (opening === "{" || opening === "[" || opening === "(") {
    const close = findMatchingDelimiter(prefix, valueStart)
    if (close !== null) return prefix.slice(valueStart, close + 1).trim()
  }
  const literal = readJsStringLiteral(prefix, valueStart)
  if (literal) return prefix.slice(valueStart, literal.endIndex).trim()
  return argumentSource
}

/**
 * Extract actual tool invocations from a Codex code-mode `exec` script.
 *
 * This is a lexer, not a JavaScript evaluator: it deliberately ignores strings
 * and comments, balances nested literals, and only recognizes calls rooted at
 * the injected `tools` object. That keeps transcript rendering deterministic
 * and safe even when the persisted script is malformed or user-controlled.
 */
export function extractCodexExecInvocations(source: string): CodexExecInvocation[] {
  const calls: CodexExecInvocation[] = []

  for (let index = 0; index < source.length; index++) {
    const skipped = skipStringOrComment(source, index)
    if (skipped) {
      index = skipped.endIndex - 1
      continue
    }

    if (!source.startsWith("tools", index) || isIdentifierPart(source[index - 1]) || isIdentifierPart(source[index + 5])) {
      continue
    }

    let cursor = skipTrivia(source, index + 5)
    let toolName = ""
    if (source[cursor] === ".") {
      cursor = skipTrivia(source, cursor + 1)
      const identifier = readIdentifier(source, cursor)
      if (!identifier) continue
      toolName = identifier.value
      cursor = identifier.endIndex
    } else if (source[cursor] === "[") {
      cursor = skipTrivia(source, cursor + 1)
      const property = readJsStringLiteral(source, cursor)
      if (!property) continue
      cursor = skipTrivia(source, property.endIndex)
      if (source[cursor] !== "]") continue
      toolName = property.value
      cursor++
    } else {
      continue
    }

    cursor = skipTrivia(source, cursor)
    if (source[cursor] !== "(") continue
    const closeIndex = findMatchingDelimiter(source, cursor)
    if (closeIndex === null) {
      calls.push({
        name: toolName,
        argumentSource: source.slice(cursor + 1).trim(),
        startIndex: index,
      })
      break
    }
    const rawArguments = source.slice(cursor + 1, closeIndex).trim()
    calls.push({
      name: toolName,
      argumentSource: resolveAssignedArgument(source, index, rawArguments),
      startIndex: index,
    })
  }

  return calls
}

/** Read an object key — quoted or bare — at `startIndex`. */
function propertyKeyAt(source: string, startIndex: number): JsStringLiteral | null {
  return readJsStringLiteral(source, startIndex) ?? readIdentifier(source, startIndex)
}

function findValueEnd(source: string, startIndex: number, objectCloseIndex: number): number {
  const stack: string[] = []
  for (let index = startIndex; index < objectCloseIndex; index++) {
    const skipped = skipStringOrComment(source, index)
    if (skipped) {
      index = skipped.endIndex - 1
      continue
    }

    const char = source[index]
    if (CLOSERS[char]) {
      stack.push(CLOSERS[char])
      continue
    }
    if (stack.length > 0 && char === stack.at(-1)) {
      stack.pop()
      continue
    }
    if (stack.length === 0 && char === ",") return index
  }
  return objectCloseIndex
}

/** Return the source expression for a top-level property of an object argument. */
export function extractJsPropertySource(source: string, property: string): string | null {
  let objectStart = skipTrivia(source, 0)
  while (source[objectStart] === "(") objectStart = skipTrivia(source, objectStart + 1)
  if (source[objectStart] !== "{") return null
  const objectClose = findMatchingDelimiter(source, objectStart)
  if (objectClose === null) return null

  let cursor = objectStart + 1
  while (cursor < objectClose) {
    cursor = skipTrivia(source, cursor)
    if (source[cursor] === ",") {
      cursor++
      continue
    }
    const key = propertyKeyAt(source, cursor)
    if (!key) {
      cursor++
      continue
    }
    cursor = skipTrivia(source, key.endIndex)
    if (source[cursor] !== ":") {
      cursor++
      continue
    }
    const valueStart = skipTrivia(source, cursor + 1)
    const valueEnd = findValueEnd(source, valueStart, objectClose)
    if (key.value === property) return source.slice(valueStart, valueEnd).trim()
    cursor = valueEnd + 1
  }
  return null
}

/** Collect the values of `property` at any nesting depth, as read by `readValue`. */
function collectPropertyValues<T>(
  source: string,
  property: string,
  readValue: (valueStart: number) => T | null,
): T[] {
  const values: T[] = []
  for (let index = 0; index < source.length; index++) {
    const afterComment = skipComment(source, index)
    if (afterComment !== null) {
      index = afterComment - 1
      continue
    }

    const key = propertyKeyAt(source, index)
    if (!key) continue
    if (key.value === property && !isIdentifierPart(source[index - 1])) {
      const colonIndex = skipTrivia(source, key.endIndex)
      if (source[colonIndex] === ":") {
        const value = readValue(skipTrivia(source, colonIndex + 1))
        if (value !== null) values.push(value)
      }
    }
    index = key.endIndex - 1
  }
  return values
}

/** Find simple string-valued object properties at any nesting depth. */
export function extractJsStringPropertyValues(source: string, property: string): string[] {
  return collectPropertyValues(
    source,
    property,
    (valueStart) => readJsStringLiteral(source, valueStart)?.value ?? null,
  )
}

/** Find simple numeric object properties at any nesting depth. */
export function extractJsNumberPropertyValues(source: string, property: string): number[] {
  return collectPropertyValues(source, property, (valueStart) => {
    const match = source.slice(valueStart).match(/^-?[\d_]+(?:\.\d+)?/)
    if (!match) return null
    const value = Number(match[0].replaceAll("_", ""))
    return Number.isFinite(value) ? value : null
  })
}

/** Count top-level entries in an array literal, or one for a non-empty value. */
export function countJsCollectionEntries(source: string): number {
  const start = skipTrivia(source, 0)
  if (!source.slice(start).trim()) return 0
  if (source[start] !== "[") return 1
  const close = findMatchingDelimiter(source, start)
  if (close === null) return 1

  let count = 0
  let hasValue = false
  const stack: string[] = []
  for (let index = start + 1; index < close; index++) {
    const skipped = skipStringOrComment(source, index)
    if (skipped) {
      hasValue ||= skipped.isString
      index = skipped.endIndex - 1
      continue
    }
    const char = source[index]
    if (CLOSERS[char]) {
      hasValue = true
      stack.push(CLOSERS[char])
    } else if (stack.length > 0 && char === stack.at(-1)) {
      stack.pop()
    } else if (stack.length === 0 && char === ",") {
      if (hasValue) count++
      hasValue = false
    } else if (!/\s/.test(char)) {
      hasValue = true
    }
  }
  return count + (hasValue ? 1 : 0)
}
