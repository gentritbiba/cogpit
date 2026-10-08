import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const version = "0.160.0"
const output = new URL("../server/agents/generated/", import.meta.url)
type Schema = { [key: string]: unknown; $ref?: string; type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; const?: unknown; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[]; items?: Schema; additionalProperties?: boolean | Schema; definitions?: Record<string, Schema> }
interface Bundle { version: string; requests: Record<string, string>; definitions: Record<string, Schema> }
const methods = ["initialize", "thread/start", "thread/resume", "turn/start", "turn/steer", "turn/interrupt", "thread/goal/set", "thread/goal/get", "thread/goal/clear"]
function type(schema: Schema): string {
  if (schema.$ref) return schema.$ref.split("/").at(-1)!
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ")
  const union = schema.anyOf ?? schema.oneOf
  if (union) {
    const alternatives = union.map((value) => `(${type(value)})`).join(" | ")
    return schema.properties ? `${type({ ...schema, anyOf: undefined, oneOf: undefined })} & (${alternatives})` : alternatives
  }
  if (schema.allOf) return schema.allOf.map((value) => `(${type(value)})`).join(" & ")
  if (Array.isArray(schema.type)) return schema.type.map((value) => type({ ...schema, type: value })).join(" | ")
  if (schema.type === "null") return "null"
  if (schema.type === "integer" || schema.type === "number") return "number"
  if (schema.type === "string" || schema.type === "boolean") return schema.type
  if (schema.type === "array") return `Array<${type(schema.items ?? {})}>`
  if (schema.type === "object" || schema.properties) {
    const properties = Object.entries(schema.properties ?? {}).map(([key, value]) => `${JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${type(value)}`)
    if (schema.additionalProperties && !properties.length) return `Record<string, ${schema.additionalProperties === true ? "unknown" : type(schema.additionalProperties)}>`
    return properties.length ? `{ ${properties.join("; ")} }` : "Record<string, unknown>"
  }
  return "unknown"
}
async function refresh(directory?: string): Promise<Bundle> {
  const scratch = directory ?? await mkdtemp(join(tmpdir(), "cogpit-codex-schema-"))
  try {
    if (!directory) {
      const installed = spawnSync("codex", ["--version"], { encoding: "utf8" })
      if (installed.status !== 0 || installed.stdout.trim() !== `codex-cli ${version}`) throw new Error(`Install Codex ${version} before refreshing protocol contracts`)
      const generated = spawnSync("codex", ["app-server", "generate-json-schema", "--experimental", "--out", scratch], { encoding: "utf8" })
      if (generated.status !== 0) throw new Error(generated.stderr)
    }
    const request = JSON.parse(await readFile(join(scratch, "ClientRequest.json"), "utf8")) as Schema
    const available: Record<string, Schema> = {}
    function add(name: string, schema: Schema): void {
      available[name.split("/").at(-1)!] = JSON.parse(JSON.stringify(schema).replace(/#\/definitions\/(?:v[12]\/)/g, "#/definitions/")) as Schema
    }
    for (const [name, schema] of Object.entries(request.definitions ?? {})) add(name, schema)
    for (const directoryName of ["", "v2"]) {
      for (const file of await readdir(join(scratch, directoryName))) {
        if (!file.endsWith(".json")) continue
        const schema = JSON.parse(await readFile(join(scratch, directoryName, file), "utf8")) as Schema
        for (const [name, definition] of Object.entries(schema.definitions ?? {})) add(name, definition)
        if (typeof schema.title === "string") add(schema.title, { ...schema, definitions: undefined })
      }
    }
    const requests: Record<string, string> = {}
    for (const envelope of request.oneOf ?? []) {
      const method = envelope.properties?.method?.enum?.[0] ?? envelope.properties?.method?.const
      if (typeof method === "string" && methods.includes(method)) requests[method] = envelope.properties!.params!.$ref!.split("/").at(-1)!
    }
    if (Object.keys(requests).length !== methods.length) throw new Error("Pinned protocol is missing a supported request")
    const roots = [...Object.values(requests), "UserInput", "ThreadStartResponse", "ThreadResumeResponse", "TurnStartResponse", "TurnSteerResponse", "ThreadGoal", "TurnCompletedNotification", "InitializeResponse"]
    const definitions: Record<string, Schema> = {}
    function visit(name: string): void {
      if (definitions[name]) return
      const schema = available[name]
      if (!schema) throw new Error(`Missing generated definition ${name}`)
      definitions[name] = schema
      for (const match of JSON.stringify(schema).matchAll(/"\$ref":"#\/definitions\/([^"]+)"/g)) visit(match[1]!)
    }
    for (const name of roots) visit(name)
    return { version, requests: Object.fromEntries(Object.entries(requests).sort()), definitions: Object.fromEntries(Object.entries(definitions).sort()) }
  } finally { if (!directory) await rm(scratch, { recursive: true, force: true }) }
}
const fixture = new URL("codex-protocol.schema.json", output)
const bundle = process.argv.includes("--refresh") ? await refresh(process.argv.find((value) => value.startsWith("--from="))?.slice(7)) : JSON.parse(await readFile(fixture, "utf8")) as Bundle
if (bundle.version !== version) throw new Error("Protocol fixture and generator versions differ")
const serialized = JSON.stringify(bundle, null, 2) + "\n"
const hash = createHash("sha256").update(serialized).digest("hex")
const generated = `// Generated from OpenAI Codex ${version}; run bun scripts/generate-codex-protocol.ts --refresh.\n// Apache-2.0; see codex-LICENSE. Schema SHA-256: ${hash}\n\n` + Object.entries(bundle.definitions).map(([name, schema]) => `export type ${name} = ${type(schema)}\n`).join("") + `\nexport interface CodexRequestParams {\n${Object.entries(bundle.requests).map(([method, name]) => `  ${JSON.stringify(method)}: ${name}`).join("\n")}\n}\n`
const target = new URL("codex-protocol.ts", output)
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== generated || await readFile(fixture, "utf8") !== serialized) throw new Error("Generated Codex protocol drift; regenerate before committing")
  const provenance = JSON.parse(await readFile(new URL("codex-provenance.json", output), "utf8")) as { cliVersion: string; ref: string; schemaSha256: string }
  if (provenance.cliVersion !== version || provenance.ref !== `rust-v${version}` || provenance.schemaSha256 !== hash) throw new Error("Codex protocol provenance drift")
  console.log(`Codex ${version} protocol contract verified (${Object.keys(bundle.definitions).length} definitions)`)
} else {
  await writeFile(fixture, serialized); await writeFile(target, generated)
  await writeFile(new URL("codex-provenance.json", output), JSON.stringify({ upstream: "https://github.com/openai/codex", ref: `rust-v${version}`, cliVersion: version, generator: "codex app-server generate-json-schema --experimental", schemaSha256: hash, license: "Apache-2.0", compatibility: "Outgoing known request fields use generated contracts. Unknown incoming fields are retained by existing decoders; native RPC IDs remain unchanged." }, null, 2) + "\n")
}
