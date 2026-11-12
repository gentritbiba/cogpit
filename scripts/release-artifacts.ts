/**
 * Puts a release together (`.github/workflows/release.yml`).
 *
 *   bun scripts/release-artifacts.ts collect <out>     after `bun run desktop:build`: this platform's
 *                                                      files, under the names the release publishes
 *   bun scripts/release-artifacts.ts manifests <dir>   over every platform's files: writes the update
 *                                                      manifests and checks the release is complete;
 *                                                      --verify also checks every update file is signed
 *                                                      with the key installed apps trust
 *
 * COGPIT_ELECTRON_BRIDGE=1 adds what installs still running the Electron app
 * need to update themselves: the macOS zip and the latest*.yml manifests.
 * With TAURI_SIGNING_PRIVATE_KEY set, `collect` signs the pacman package the
 * way the desktop build signs the other update files.
 */
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildPacmanPackage } from "./lib/pacmanPackage"
import { artifactNames, electronManifests, onlyFile, publishedFiles, updaterManifest, type ReleaseArch, type ReleasePlatform } from "./lib/releaseArtifacts"
import { root } from "./lib/sourceFiles"

const electronBridge = process.env.COGPIT_ELECTRON_BRIDGE === "1"
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status}).`)
}

/** Copy an update file and, when the build signed it, its signature. */
function copyUpdate(source: string, output: string, name: string): void {
  cpSync(source, join(output, name))
  if (existsSync(`${source}.sig`)) cpSync(`${source}.sig`, join(output, `${name}.sig`))
}

function collect(output: string): void {
  const platform = process.platform as ReleasePlatform
  const names = artifactNames(platform, process.arch as ReleaseArch, version)
  const bundle = join(process.env.CARGO_TARGET_DIR?.trim() || join(root, "desktop/target"), "release/bundle")
  mkdirSync(output, { recursive: true })

  if (platform === "darwin") {
    cpSync(onlyFile(join(bundle, "dmg"), ".dmg"), join(output, names.installer!))
    copyUpdate(join(bundle, "macos/Cogpit.app.tar.gz"), output, names.update)
    if (electronBridge) {
      const app = join(bundle, "macos/Cogpit.app")
      if (!existsSync(join(app, "Contents/Resources/app.asar"))) {
        throw new Error("The app was built without COGPIT_ELECTRON_BRIDGE=1; the Electron updater would reject it.")
      }
      run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, join(output, names.electronUpdate!)])
    }
  } else if (platform === "linux") {
    copyUpdate(onlyFile(join(bundle, "appimage"), ".AppImage"), output, names.update)
    const pacman = join(output, names.pacman!)
    buildPacmanPackage({ deb: onlyFile(join(bundle, "deb"), ".deb"), output: pacman, version, repoRoot: root })
    if (process.env.TAURI_SIGNING_PRIVATE_KEY) run("bunx", ["tauri", "signer", "sign", "--app-version", version, pacman])
  } else {
    copyUpdate(onlyFile(join(bundle, "nsis"), "-setup.exe"), output, names.update)
  }
  console.log(`Collected for ${platform}-${process.arch}:\n${readdirSync(output).map((name) => `  ${name}`).join("\n")}`)
}

async function manifests(directory: string, verify: boolean): Promise<void> {
  const publishedAt = new Date()
  const config = JSON.parse(readFileSync(join(root, "desktop/tauri.conf.json"), "utf8")) as { plugins: { updater: { pubkey: string } } }
  const manifest = updaterManifest(directory, version, publishedAt, verify ? config.plugins.updater.pubkey : undefined)
  writeFileSync(join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  // The signatures are in latest.json; the release does not carry them twice.
  for (const name of readdirSync(directory)) if (name.endsWith(".sig")) rmSync(join(directory, name))
  if (electronBridge) {
    for (const [name, manifest] of Object.entries(await electronManifests(directory, version, publishedAt))) {
      writeFileSync(join(directory, name), manifest)
    }
  }
  const expected = publishedFiles(version, electronBridge)
  const actual = readdirSync(directory).sort()
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(`The release should hold exactly:\n  ${expected.join("\n  ")}\nbut holds:\n  ${actual.join("\n  ")}`)
  }
  console.log(`Release ${version} is complete:\n${actual.map((name) => `  ${name}`).join("\n")}`)
}

const [command, directory, option] = process.argv.slice(2)
if (command === "collect" && directory && !option) collect(directory)
else if (command === "manifests" && directory && (!option || option === "--verify")) await manifests(directory, option === "--verify")
else throw new Error("Usage: bun scripts/release-artifacts.ts collect <directory> | manifests <directory> [--verify]")
