/** JSON.parse alone loses duplicate keys before a signature-bound document is validated. */
export function parseJsonText(bytes: Uint8Array, maxBytes: number, limits: { maxNodes?: number; maxDepth?: number } = {}): unknown {
  if (bytes.byteLength > maxBytes) throw new Error("JSON document exceeds its size limit")
  const maxNodes = limits.maxNodes ?? 50000, maxDepth = limits.maxDepth ?? 32
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 100000 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) throw new Error("Invalid JSON complexity limits")
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  let offset = 0
  let nodes = 0
  const scalar = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y
  const whitespace = () => { while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++ }
  const fail = (): never => { throw new Error(`Invalid JSON at offset ${offset}`) }
  const string = (): string => {
    const start = offset++
    while (offset < text.length) {
      const character = text[offset++]
      if (character === "\\") offset++
      else if (character === '"') {
        const decoded = JSON.parse(text.slice(start, offset)) as string
        for (let index = 0; index < decoded.length; index++) {
          const unit = decoded.charCodeAt(index)
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const low = decoded.charCodeAt(++index)
            if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("Invalid Unicode surrogate")
          } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error("Invalid Unicode surrogate")
        }
        return decoded
      }
    }
    return fail()
  }
  const value = (depth: number): void => {
    if (depth > maxDepth || ++nodes > maxNodes) throw new Error("JSON document is too complex")
    whitespace()
    const token = text[offset]
    if (token === '"') { string(); return }
    if (token === "{" || token === "[") {
      const object = token === "{"
      const end = object ? "}" : "]"
      const keys = new Set<string>()
      offset++
      whitespace()
      if (text[offset] === end) { offset++; return }
      while (offset < text.length) {
        if (object) {
          if (text[offset] !== '"') fail()
          const key = string()
          if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key.slice(0, 80)}`)
          keys.add(key)
          whitespace()
          if (text[offset++] !== ":") fail()
        }
        value(depth + 1)
        whitespace()
        const separator = text[offset++]
        if (separator === end) return
        if (separator !== ",") fail()
        whitespace()
      }
      fail()
    }
    scalar.lastIndex = offset
    const match = scalar.exec(text)
    if (!match) fail()
    if (/^[-\d]/.test(match![0]) && !Number.isFinite(Number(match![0]))) throw new Error("Non-finite JSON number")
    offset += match![0].length
  }
  value(0)
  whitespace()
  if (offset !== text.length) fail()
  return JSON.parse(text) as unknown
}
