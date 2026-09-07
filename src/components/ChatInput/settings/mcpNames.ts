/** Words that say what a thing is rather than which one it is. */
const NOISE = new Set(["mcp", "server", "servers", "api", "app", "the", "and"])

const NAMESPACE = /^([\w-]+\.[a-z]{2,})\s+(.+)$/i

/**
 * A server can be registered under a namespace, e.g. a connector directory
 * ("acme.dev Drive"). The namespace is worth keeping around, but it must not
 * be the part that survives truncation in a narrow tile.
 */
export function splitServerName(name: string): { short: string; namespace?: string } {
  const match = NAMESPACE.exec(name.trim())
  return match ? { short: match[2], namespace: match[1] } : { short: name.trim() }
}

/** Two letters that stand in for a server where there is no room for its name. */
export function serverMonogram(name: string): string {
  const { short } = splitServerName(name)
  const words = short.split(/[^a-z0-9]+/i).filter((word) => word && !NOISE.has(word.toLowerCase()))
  const source = words.length > 0 ? words : [short]
  const letters = source.length >= 2 ? source[0][0] + source[1][0] : source[0].slice(0, 2)
  return letters.toUpperCase()
}
