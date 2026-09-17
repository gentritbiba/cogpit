export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface ValidationIssue { path: string; message: string }

export class ContractValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "))
    this.name = "ContractValidationError"
  }
}

export const CONTRACT_LIMITS = Object.freeze({
  manifestBytes: 65536, definitionBytes: 32768, messageBytes: 65536,
  argumentBytes: 4096, responseBytes: 2 * 1024 * 1024, resultMessageBytes: 2 * 1024 * 1024 + 16384,
  storageValueBytes: 32768, responseNodes: 100000, depth: 16, nodes: 4096,
  outstandingRequests: 32, requestTimeoutMs: 30000, composerBytes: 16384,
})

export function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength }

export function parseJson(value: unknown, options: { maxBytes?: number; maxDepth?: number; maxNodes?: number } = {}): JsonValue {
  const maxBytes = options.maxBytes ?? CONTRACT_LIMITS.messageBytes
  const maxDepth = options.maxDepth ?? CONTRACT_LIMITS.depth
  const maxNodes = options.maxNodes ?? CONTRACT_LIMITS.nodes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > CONTRACT_LIMITS.depth
    || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > CONTRACT_LIMITS.responseNodes + 16) {
    throw new ContractValidationError([{ path: "$", message: "Invalid JSON limits" }])
  }
  let budget = maxBytes
  let nodes = maxNodes
  const ancestors = new Set<object>()
  const reject = (path: string): never => { throw new ContractValidationError([{ path, message: "Expected bounded JSON data" }]) }
  function walk(input: unknown, depth: number, path: string): JsonValue {
    if (--nodes < 0 || depth > maxDepth || (budget -= 2) < 0) return reject(path)
    if (input === null || typeof input === "boolean") return input
    if (typeof input === "number") return Number.isFinite(input) ? input : reject(path)
    if (typeof input === "string") return input.length <= budget && (budget -= utf8Length(input)) >= 0 ? input : reject(path)
    if (typeof input !== "object" || ancestors.has(input)) return reject(path)
    const prototype = Object.getPrototypeOf(input)
    if (Array.isArray(input) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return reject(path)
    const keys = Reflect.ownKeys(input)
    if (keys.length > nodes + 1 || keys.some((key) => typeof key === "symbol")) return reject(path)
    const descriptors = Object.getOwnPropertyDescriptors(input)
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set || !Object.hasOwn(descriptor, "value")) return reject(path)
    }
    ancestors.add(input)
    let output: JsonValue
    if (Array.isArray(input)) {
      if (input.length > maxNodes || Object.keys(descriptors).length !== input.length + 1) return reject(path)
      output = Array.from({ length: input.length }, (_, index) => {
        const item = descriptors[String(index)]
        if (!item?.enumerable) return reject(`${path}[${index}]`)
        return walk(item.value, depth + 1, `${path}[${index}]`)
      })
    } else {
      const record: Record<string, JsonValue> = Object.create(null)
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || ["__proto__", "prototype", "constructor"].includes(key) || (budget -= utf8Length(key) + 3) < 0) return reject(`${path}.${key}`)
        record[key] = walk(descriptor.value, depth + 1, `${path}.${key}`)
      }
      output = record
    }
    ancestors.delete(input)
    return output
  }
  const result = walk(value, 0, "$")
  if (utf8Length(JSON.stringify(result)) > maxBytes) return reject("$")
  return result
}
