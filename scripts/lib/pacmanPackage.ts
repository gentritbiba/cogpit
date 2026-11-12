/**
 * Builds the pacman package from the deb the desktop build produces. The
 * package keeps the name and the `/opt/Cogpit/cogpit` executable of the
 * packages up to 3.6.x, so installing it upgrades them in place (the Electron
 * app's updater does exactly that, with `pacman -U`).
 *
 * `aur/PKGBUILD.template` (the dependencies) and `aur/cogpit.install` are
 * shared with the AUR package, which repackages this file.
 */
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The executables the deb puts in /usr/bin; the package keeps them together in /opt/Cogpit. */
const EXECUTABLES = ["cogpit", "cogpit-bun", "cogpit-core"]
const APP_DIR = "opt/Cogpit"
/** The app reads its resources from here (Tauri's fixed location) and learns it is a pacman install. */
const RESOURCES_DIR = "usr/lib/Cogpit"

export function pacmanDepends(pkgbuild: string): string[] {
  const list = pkgbuild.match(/^depends=\(([^)]*)\)/m)?.[1]
  const depends = [...(list ?? "").matchAll(/'([^']+)'/g)].map((match) => match[1])
  if (depends.length === 0) throw new Error("aur/PKGBUILD.template no longer lists its depends.")
  return depends
}

export function pkginfo(options: { version: string; arch: string; description: string; size: number; builtAt: Date; depends: string[] }): string {
  return [
    "pkgname = cogpit",
    "pkgbase = cogpit",
    "xdata = pkgtype=pkg",
    `pkgver = ${options.version}-1`,
    `pkgdesc = ${options.description}`,
    "url = https://github.com/gentritbiba/cogpit",
    `builddate = ${Math.floor(options.builtAt.getTime() / 1000)}`,
    "packager = Gentrit Biba <gentritbiba@gmail.com>",
    `size = ${options.size}`,
    `arch = ${options.arch}`,
    "license = MIT",
    ...options.depends.map((name) => `depend = ${name}`),
    "",
  ].join("\n")
}

/** Launchers start the executable where this package keeps it. */
export function desktopEntry(entry: string): string {
  if (!/^Exec=/m.test(entry)) throw new Error("The desktop entry has no Exec line.")
  return entry.replace(/^Exec=\S+/m, `Exec=/${APP_DIR}/cogpit`)
}

function bsdtar(args: string[], cwd: string): void {
  const result = spawnSync("bsdtar", args, { cwd, stdio: "inherit", env: { ...process.env, LANG: "C" } })
  if (result.status !== 0) throw new Error(`bsdtar ${args.join(" ")} failed (${result.signal ?? result.status}).`)
}

function treeSize(directory: string): number {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .reduce((total, entry) => total + statSync(join(entry.parentPath, entry.name)).size, 0)
}

export function buildPacmanPackage(options: { deb: string; output: string; version: string; repoRoot: string }): void {
  const work = mkdtempSync(join(tmpdir(), "cogpit-pacman-"))
  try {
    const debDir = join(work, "deb")
    const pkgDir = join(work, "pkg")
    mkdirSync(debDir)
    mkdirSync(pkgDir)
    bsdtar(["-xf", options.deb], debDir)
    const data = readdirSync(debDir).find((name) => name.startsWith("data.tar"))
    if (!data) throw new Error(`${options.deb} holds no data archive.`)
    bsdtar(["-xf", join(debDir, data)], pkgDir)

    mkdirSync(join(pkgDir, APP_DIR), { recursive: true })
    for (const name of EXECUTABLES) renameSync(join(pkgDir, "usr/bin", name), join(pkgDir, APP_DIR, name))
    rmSync(join(pkgDir, "usr/bin"), { recursive: true })
    writeFileSync(join(pkgDir, RESOURCES_DIR, "package-type"), "pacman\n")
    const applications = join(pkgDir, "usr/share/applications")
    for (const name of readdirSync(applications)) {
      writeFileSync(join(applications, name), desktopEntry(readFileSync(join(applications, name), "utf8")))
    }

    const manifest = JSON.parse(readFileSync(join(options.repoRoot, "package.json"), "utf8")) as { description: string }
    const control = spawnSync("bsdtar", ["-xOf", join(debDir, readdirSync(debDir).find((name) => name.startsWith("control.tar"))!), "./control"], { encoding: "utf8" })
    const arch = /^Architecture: arm64$/m.test(control.stdout) ? "aarch64" : "x86_64"
    writeFileSync(join(pkgDir, ".PKGINFO"), pkginfo({
      version: options.version,
      arch,
      description: manifest.description,
      size: treeSize(pkgDir),
      builtAt: new Date(),
      depends: pacmanDepends(readFileSync(join(options.repoRoot, "aur/PKGBUILD.template"), "utf8")),
    }))
    cpSync(join(options.repoRoot, "aur/cogpit.install"), join(pkgDir, ".INSTALL"))

    // Everything belongs to root, as makepkg's fakeroot would have it.
    const owner = ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"]
    const content = [".PKGINFO", ".INSTALL", "opt", "usr"]
    bsdtar(["-czf", ".MTREE", "--format=mtree", "--options=!all,use-set,type,uid,gid,mode,time,size,md5,sha256,link", ...owner, ...content], pkgDir)
    bsdtar(["--zstd", "-cf", options.output, ...owner, ".PKGINFO", ".INSTALL", ".MTREE", "opt", "usr"], pkgDir)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
