/**
 * The files a release publishes and the two kinds of update manifest that
 * point at them:
 *
 * - `latest.json`: the desktop app's updater (`desktop/src/updater.rs`).
 * - `latest-mac.yml`, `latest-linux.yml`, `latest.yml`: what installs that
 *   still run the Electron app (up to 3.6.x) read. Publishing them lets those
 *   installs update themselves to this app.
 */
import { createHash } from "node:crypto"
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { dump } from "js-yaml"
import { verifyUpdateSignature } from "./updateSignature"

export type ReleasePlatform = "darwin" | "linux" | "win32"
export type ReleaseArch = "arm64" | "x64"

const RELEASE_DOWNLOADS = "https://github.com/gentritbiba/cogpit/releases/download"

/** What one platform's build contributes, by role. Names match what the Electron releases used. */
export function artifactNames(platform: ReleasePlatform, arch: ReleaseArch, version: string) {
  if (platform === "darwin") {
    const suffix = arch === "arm64" ? "-arm64" : ""
    return {
      installer: `Cogpit-${version}${suffix}.dmg`,
      update: `Cogpit-${version}-${arch}.app.tar.gz`,
      // The Electron updater takes the zip with `-arm64-` in its name on Apple silicon and the other one on Intel.
      electronUpdate: `Cogpit-${version}${suffix}-mac.zip`,
    }
  }
  if (platform === "linux") {
    if (arch !== "x64") throw new Error("The Linux desktop app is built for x64 only.")
    return { update: `Cogpit-${version}.AppImage`, pacman: `cogpit-${version}.pacman` }
  }
  if (arch !== "x64") throw new Error("The Windows desktop app is built for x64 only.")
  return { update: `Cogpit-${version}-setup.exe` }
}

/** The one file in `directory` whose name ends with `suffix`. */
export function onlyFile(directory: string, suffix: string): string {
  const matches = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(suffix)) : []
  if (matches.length !== 1) throw new Error(`Expected one *${suffix} in ${directory}, found ${matches.length}.`)
  return join(directory, matches[0])
}

/** Every file a complete release holds, by the updater target that downloads it. */
function updateFiles(version: string): Record<string, string> {
  return {
    "darwin-aarch64": artifactNames("darwin", "arm64", version).update,
    "darwin-x86_64": artifactNames("darwin", "x64", version).update,
    "linux-x86_64": artifactNames("linux", "x64", version).update,
    "linux-x86_64-pacman": artifactNames("linux", "x64", version).pacman!,
    "windows-x86_64": artifactNames("win32", "x64", version).update,
  }
}

export interface UpdaterManifest {
  version: string
  notes: string
  pub_date: string
  platforms: Record<string, { signature: string; url: string }>
}

/**
 * `latest.json`, from the signature (`<file>.sig`) beside each update file.
 * With `trustedKey` (the public key installed apps carry) every signature must
 * also be that key's, over that file, for this version.
 */
export function updaterManifest(directory: string, version: string, publishedAt: Date, trustedKey?: string): UpdaterManifest {
  const platforms: UpdaterManifest["platforms"] = {}
  for (const [target, file] of Object.entries(updateFiles(version))) {
    const signaturePath = join(directory, `${file}.sig`)
    if (!existsSync(join(directory, file))) throw new Error(`The release is missing ${file}.`)
    if (!existsSync(signaturePath)) throw new Error(`${file} is not signed: ${signaturePath} is missing.`)
    const signature = readFileSync(signaturePath, "utf8").trim()
    if (trustedKey) {
      let signed
      try {
        signed = verifyUpdateSignature(join(directory, file), signature, trustedKey)
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`)
      }
      if (signed.version !== version) throw new Error(`${file} is signed for version ${signed.version ?? "none"}, not ${version}.`)
    }
    platforms[target] = { signature, url: `${RELEASE_DOWNLOADS}/v${version}/${file}` }
  }
  return {
    version,
    notes: `https://github.com/gentritbiba/cogpit/releases/tag/v${version}`,
    pub_date: publishedAt.toISOString(),
    platforms,
  }
}

async function sha512(path: string): Promise<string> {
  const hash = createHash("sha512")
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest("base64")
}

/** One electron-updater manifest; the first file is the one its legacy top-level fields describe. */
async function electronManifest(directory: string, version: string, publishedAt: Date, names: string[]): Promise<string> {
  const files = []
  for (const name of names) {
    const path = join(directory, name)
    if (!existsSync(path)) throw new Error(`The release is missing ${name}.`)
    files.push({ url: name, sha512: await sha512(path), size: statSync(path).size })
  }
  return dump({
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: publishedAt.toISOString(),
  }, { lineWidth: -1 })
}

/** The manifests the Electron app's updater reads, by file name. */
export async function electronManifests(directory: string, version: string, publishedAt: Date): Promise<Record<string, string>> {
  const mac = [artifactNames("darwin", "x64", version), artifactNames("darwin", "arm64", version)]
  const linux = artifactNames("linux", "x64", version)
  return {
    "latest-mac.yml": await electronManifest(directory, version, publishedAt, mac.map((names) => names.electronUpdate!)),
    "latest-linux.yml": await electronManifest(directory, version, publishedAt, [linux.update, linux.pacman!]),
    "latest.yml": await electronManifest(directory, version, publishedAt, [artifactNames("win32", "x64", version).update]),
  }
}

/** The names a published release holds, and nothing else. */
export function publishedFiles(version: string, electronBridge: boolean): string[] {
  const mac = [artifactNames("darwin", "arm64", version), artifactNames("darwin", "x64", version)]
  const linux = artifactNames("linux", "x64", version)
  return [
    ...mac.flatMap((names) => [names.installer!, names.update]),
    linux.update,
    linux.pacman!,
    artifactNames("win32", "x64", version).update,
    "latest.json",
    ...(electronBridge
      ? [...mac.map((names) => names.electronUpdate!), "latest-mac.yml", "latest-linux.yml", "latest.yml"]
      : []),
  ].sort()
}
