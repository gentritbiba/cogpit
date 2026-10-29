import type { Plugin } from "unified"

interface Point { line: number; column: number; offset?: number }
export interface MarkdownNode {
  type: string
  children?: MarkdownNode[]
  position?: { start: Point; end: Point }
}

// Only independent top-level blocks are cached. Document-wide resolution and
// container continuation use the full parser, including while syntax is partial.
class BoundaryScanner {
  private offset = 0
  private boundary = 0
  private fence: { marker: string; length: number } | null = null
  private unsafe = false
  scannedCharacters = 0

  scan(source: string): number | null {
    if (this.unsafe) return null
    while (this.offset < source.length) {
      const newline = source.indexOf("\n", this.offset)
      const complete = newline !== -1
      const end = complete ? newline : source.length
      const raw = source.slice(this.offset, end)
      this.scannedCharacters += raw.length
      const line = complete ? raw.replace(/\r$/, "") : raw
      const logical = this.offset === 0 ? line.replace(/^\uFEFF/, "") : line
      if (/[\r\uFEFF]/.test(logical)) {
        if (complete) this.unsafe = true
        return null
      }
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(logical)
      let fence = this.fence
      let boundary = this.boundary
      if (fence) {
        if (match && match[1][0] === fence.marker && match[1].length >= fence.length && /^[ \t]*$/.test(match[2]) && complete) {
          fence = null
          boundary = end + 1
        }
      } else if (match) {
        if (match[1][0] === "`" && match[2].includes("`")) {
          if (complete) this.unsafe = true
          return null
        }
        fence = { marker: match[1][0], length: match[1].length }
      } else {
        if (/[[\]<>|]/.test(logical) || /^(?: {4}|\t| {0,3}(?:>|[-+*](?:\s|$)|\d+[.)](?:\s|$)))/.test(logical) || /^ {0,3}[=-]+\s*$/.test(logical)) {
          if (complete) this.unsafe = true
          return null
        }
        if (complete && /^[ \t]*$/.test(logical)) boundary = end + 1
      }
      if (!complete) break
      this.offset = end + 1
      this.fence = fence
      this.boundary = boundary
    }
    return this.boundary
  }
}

function copyShift(node: MarkdownNode, offset: number, lines: number): MarkdownNode {
  const result = { ...node }
  if (node.position) {
    const shift = (point: Point): Point => ({ ...point, line: point.line + lines, ...(point.offset === undefined ? {} : { offset: point.offset + offset }) })
    result.position = { start: shift(node.position.start), end: shift(node.position.end) }
  }
  if (node.children) result.children = node.children.map(child => copyShift(child, offset, lines))
  return result
}

export const MARKDOWN_CACHE_LIMITS = { characters: 1_000_000, topLevelNodes: 256, nodes: 8192, bytes: 4 * 1024 * 1024 } as const

function retainedTreeSize(children: MarkdownNode[], sourceCharacters: number) {
  const pending = [...children]
  let nodes = 0, bytes = sourceCharacters * 2 + 320
  while (pending.length) {
    const node = pending.pop()!
    nodes++
    bytes += 320 + (node.children?.length ?? 0) * 8
    for (const value of Object.values(node)) if (typeof value === "string") bytes += value.length * 2
    if (nodes > MARKDOWN_CACHE_LIMITS.nodes || bytes > MARKDOWN_CACHE_LIMITS.bytes) return null
    if (node.children) for (const child of node.children) pending.push(child)
  }
  return { nodes, bytes }
}

export class IncrementalMarkdownParser {
  private scanner = new BoundaryScanner()
  private cacheSize = { nodes: 0, bytes: 0 }
  private prefixLines = 0
  private previous = ""
  private prefix = ""
  private prefixTree: MarkdownNode | null = null
  private parsedCharacters = 0
  private parseCalls = 0
  private fullParses = 0

  parse(source: string, parser: (source: string) => MarkdownNode): MarkdownNode {
    if (!source.startsWith(this.previous)) {
      this.clearPrefix()
      this.scanner = new BoundaryScanner()
    }
    this.previous = source
    const parse = (value: string) => {
      this.parsedCharacters += value.length
      this.parseCalls++
      return parser(value)
    }
    const boundary = this.scanner.scan(source)
    // Bound retained sources/trees; large or structurally uncertain documents
    // still render completely, without growing a second unbounded cache.
    if (boundary === null || boundary > MARKDOWN_CACHE_LIMITS.characters) {
      this.clearPrefix(); this.fullParses++
      return parse(source)
    }
    const start = this.prefix.length
    const tail = source.slice(start)
    const tailTree = parse(tail)
    const bom = source.startsWith("\uFEFF") ? 1 : 0
    const shifted = start ? copyShift(tailTree, start - bom, this.prefixLines) : tailTree
    const tree: MarkdownNode = this.prefixTree ? {
      ...shifted,
      children: [...(this.prefixTree.children ?? []), ...(shifted.children ?? [])],
      position: shifted.position && { start: this.prefixTree.position!.start, end: shifted.position.end },
    } : shifted
    if (boundary > start) {
      const children = tree.children ?? []
      const completed = children.filter(node => (node.position?.end.offset ?? Infinity) <= boundary - bom)
      const size = completed.length <= MARKDOWN_CACHE_LIMITS.topLevelNodes ? retainedTreeSize(completed, boundary) : null
      if (size) {
        this.cacheSize = size
        this.prefixLines += source.slice(start, boundary).split("\n").length - 1
        this.prefix = source.slice(0, boundary)
        this.prefixTree = { ...tree, children: completed }
      } else { this.clearPrefix() }
    }
    return tree
  }

  private clearPrefix() {
    this.prefix = ""
    this.prefixTree = null
    this.prefixLines = 0
    this.cacheSize = { nodes: 0, bytes: 0 }
  }

  stats() {
    return {
      scannedCharacters: this.scanner.scannedCharacters,
      parsedCharacters: this.parsedCharacters,
      parseCalls: this.parseCalls,
      fullParses: this.fullParses,
      cachedCharacters: this.prefix.length,
      cachedNodes: this.cacheSize.nodes,
      cacheBytes: this.cacheSize.bytes,
    }
  }
}

/** Wrap react-markdown's installed remark parser, retaining its GFM extensions. */
export function incrementalMarkdownPlugin(cache: IncrementalMarkdownParser): Plugin {
  return function () {
    const parser = this.parser
    if (parser) this.parser = (source, file) => cache.parse(source, value => parser(value, file))
  }
}
