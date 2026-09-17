#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { createArchive } from "./archive.js"
import { signBundle } from "./bundle.js"
import { createPublisher, loadPublisher, rootFingerprint, savePublisher } from "./publisher.js"

const USAGE = `cogpit-plugin: sign plugin packages for Cogpit's Install from file

  cogpit-plugin keygen --publisher dev-<name> --out <keys.json> [--root <root.json>]
      Create a development publisher. Keep <keys.json> private; share <root.json>
      and its fingerprint with anyone who should trust your packages.

  cogpit-plugin pack <built-plugin-dir> --keys <keys.json> --out <file.cogpit-plugin>
      [--as dev-<name>] [--dev] [--version <semver>] [--expires-days <n>]
      Sign a built plugin directory (plugin.json, plugin.js, ...) as the next
      metadata version of the publisher. --as re-signs an official package under
      your publisher; --dev appends -dev.<n> to the version so rebuilds never reuse
      a signed version.

  cogpit-plugin fingerprint --keys <keys.json>
      Print the root fingerprint hosts must enter when enrolling the publisher.
`

interface ParsedArgs { command: string | undefined; positional: string[]; flags: Map<string, string | true> }

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]
    if (!argument.startsWith("--")) { positional.push(argument); continue }
    const name = argument.slice(2)
    const next = rest[index + 1]
    if (name === "dev" || name === "help" || next === undefined || next.startsWith("--")) flags.set(name, true)
    else { flags.set(name, next); index++ }
  }
  return { command, positional, flags }
}

function optional(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

function required(flags: ParsedArgs["flags"], name: string): string {
  const value = optional(flags, name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

async function manifestVersion(directory: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8")) as { version?: unknown }
  if (typeof manifest.version !== "string") throw new Error("plugin.json has no version")
  return manifest.version.split("-")[0]
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function keygen({ flags }: ParsedArgs): Promise<void> {
  const publisher = required(flags, "publisher")
  const out = resolve(required(flags, "out"))
  if (await exists(out)) throw new Error(`${out} already exists; refusing to overwrite publisher keys`)
  const rootPath = resolve(optional(flags, "root") ?? out.replace(/\.json$/, "") + ".root.json")
  const store = createPublisher(publisher)
  await savePublisher(out, store)
  await mkdir(dirname(rootPath), { recursive: true })
  await writeFile(rootPath, store.root)
  console.log(`Created development publisher ${publisher}\n  private keys: ${out}\n  public root:  ${rootPath}\n  fingerprint:  ${rootFingerprint(store)}`)
}

async function pack({ positional, flags }: ParsedArgs): Promise<void> {
  const [directory] = positional
  if (!directory) throw new Error("A built plugin directory is required")
  const keysPath = resolve(required(flags, "keys"))
  const out = resolve(required(flags, "out"))
  const store = await loadPublisher(keysPath)
  const publisher = optional(flags, "as")
  const version = optional(flags, "version")
  const source = resolve(directory)
  const devVersion = flags.get("dev") === true && !version ? `${await manifestVersion(source)}-dev.${store.metadataVersion + 1}` : undefined
  const archive = await createArchive(source, { publisher, version: version ?? devVersion })
  const declaredExpiry = optional(flags, "expires-days")
  const expiresDays = declaredExpiry === undefined ? undefined : Number(declaredExpiry)
  if (expiresDays !== undefined && !(Number.isInteger(expiresDays) && expiresDays > 0)) throw new Error("--expires-days must be a positive integer")
  const bundle = signBundle(store, archive, { expiresDays })
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, bundle.bytes)
  await savePublisher(keysPath, bundle.publisher)
  console.log(`Signed ${archive.manifest.id}@${archive.manifest.version} as ${store.publisher} (metadata version ${bundle.metadataVersion})\n  package: ${out}\n  sha256:  ${bundle.digest}`)
}

async function fingerprint({ flags }: ParsedArgs): Promise<void> {
  console.log(rootFingerprint(await loadPublisher(resolve(required(flags, "keys")))))
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv)
  try {
    if (!parsed.command || parsed.command === "--help" || parsed.flags.has("help")) { console.log(USAGE); return 0 }
    if (parsed.command === "keygen") await keygen(parsed)
    else if (parsed.command === "pack") await pack(parsed)
    else if (parsed.command === "fingerprint") await fingerprint(parsed)
    else throw new Error(`Unknown command: ${parsed.command}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && /[\\/]cli\.(?:js|ts)$/.test(process.argv[1])) process.exitCode = await main()
