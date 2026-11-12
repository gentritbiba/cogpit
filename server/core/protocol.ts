/** Mirrors `crates/core-protocol/src/lib.rs`; a test keeps the two in step. */
export const CORE_SECRET_HEADER = "x-cogpit-core-secret"
export const CORE_PRINCIPAL_HEADER = "x-cogpit-principal"
export const CORE_PROTOCOL_VERSION = 1

export interface CoreBootMessage {
  secret: string
  config: CoreConfig
}

export interface CoreConfig {
  dataDir: string
}

export interface CoreHandshake {
  port: number
  version: string
  protocol: number
}

export function parseHandshake(line: string): CoreHandshake {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new Error(`cogpit-core printed an unreadable handshake: ${line.slice(0, 200)}`)
  }
  const { port, version, protocol } = (value ?? {}) as Partial<CoreHandshake>
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535
    || typeof version !== "string" || typeof protocol !== "number") {
    throw new Error(`cogpit-core printed an invalid handshake: ${line.slice(0, 200)}`)
  }
  if (protocol !== CORE_PROTOCOL_VERSION) {
    throw new Error(
      `cogpit-core ${version} speaks protocol ${protocol}, this server needs ${CORE_PROTOCOL_VERSION}. `
      + "Rebuild it with `bun run build:core`.",
    )
  }
  return { port, version, protocol }
}
