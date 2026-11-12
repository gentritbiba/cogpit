// @vitest-environment node
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildPacmanPackage, desktopEntry, pacmanDepends, pkginfo } from "../../../scripts/lib/pacmanPackage"
import { root } from "../../../scripts/lib/sourceFiles"

const hasBsdtar = spawnSync("bsdtar", ["--version"]).status === 0

describe("pacmanDepends", () => {
  it("reads the AUR package's dependencies", () => {
    const depends = pacmanDepends(readFileSync(join(root, "aur/PKGBUILD.template"), "utf8"))
    expect(depends).toContain("webkit2gtk-4.1")
    expect(depends).toContain("gtk3")
  })

  it("fails loudly when the list is gone", () => {
    expect(() => pacmanDepends("pkgname=cogpit\n")).toThrow("no longer lists")
  })
})

describe("pkginfo", () => {
  it("keeps the package name the Electron packages had, so pacman upgrades them", () => {
    const info = pkginfo({
      version: "4.0.0",
      arch: "x86_64",
      description: "Control center",
      size: 1234,
      builtAt: new Date("2026-11-12T10:00:00.000Z"),
      depends: ["gtk3", "webkit2gtk-4.1"],
    })
    expect(info.split("\n")).toEqual([
      "pkgname = cogpit",
      "pkgbase = cogpit",
      "xdata = pkgtype=pkg",
      "pkgver = 4.0.0-1",
      "pkgdesc = Control center",
      "url = https://github.com/gentritbiba/cogpit",
      "builddate = 1794477600",
      "packager = Gentrit Biba <gentritbiba@gmail.com>",
      "size = 1234",
      "arch = x86_64",
      "license = MIT",
      "depend = gtk3",
      "depend = webkit2gtk-4.1",
      "",
    ])
  })
})

describe("desktopEntry", () => {
  it("starts the executable from /opt/Cogpit", () => {
    expect(desktopEntry("[Desktop Entry]\nExec=cogpit\nIcon=cogpit\n")).toBe("[Desktop Entry]\nExec=/opt/Cogpit/cogpit\nIcon=cogpit\n")
    expect(() => desktopEntry("[Desktop Entry]\nIcon=cogpit\n")).toThrow("no Exec line")
  })
})

describe.skipIf(!hasBsdtar)("buildPacmanPackage", () => {
  let work: string
  beforeEach(() => { work = mkdtempSync(join(tmpdir(), "cogpit-pacman-test-")) })
  afterEach(() => rmSync(work, { recursive: true, force: true }))

  function tar(args: string[], cwd: string): string {
    const result = spawnSync("bsdtar", args, { cwd, encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }

  /** A deb laid out as the desktop build's: executables in /usr/bin, resources in /usr/lib/Cogpit. */
  function writeDeb(): string {
    const data = join(work, "data")
    for (const name of ["cogpit", "cogpit-bun", "cogpit-core"]) {
      mkdirSync(join(data, "usr/bin"), { recursive: true })
      writeFileSync(join(data, "usr/bin", name), `#!/bin/sh\necho ${name}\n`)
      chmodSync(join(data, "usr/bin", name), 0o755)
    }
    mkdirSync(join(data, "usr/lib/Cogpit/server"), { recursive: true })
    writeFileSync(join(data, "usr/lib/Cogpit/server/desktop.js"), "// server")
    mkdirSync(join(data, "usr/share/applications"), { recursive: true })
    writeFileSync(join(data, "usr/share/applications/Cogpit.desktop"), "[Desktop Entry]\nName=Cogpit\nExec=cogpit\n")
    const control = join(work, "control")
    mkdirSync(control)
    writeFileSync(join(control, "control"), "Package: cogpit\nArchitecture: amd64\n")
    writeFileSync(join(work, "debian-binary"), "2.0\n")
    tar(["-czf", join(work, "control.tar.gz"), "./control"], control)
    tar(["-czf", join(work, "data.tar.gz"), "usr"], data)
    tar(["--format=ar", "-cf", "cogpit.deb", "debian-binary", "control.tar.gz", "data.tar.gz"], work)
    return join(work, "cogpit.deb")
  }

  it("repackages the deb with the executables in /opt/Cogpit and no file at /usr/bin/cogpit", () => {
    const output = join(work, "cogpit-4.0.0.pacman")
    // Paths relative to the working directory, as the release workflow passes them.
    const relativeTo = (path: string) => relative(process.cwd(), path)
    buildPacmanPackage({ deb: relativeTo(writeDeb()), output: relativeTo(output), version: "4.0.0", repoRoot: root })

    const files = tar(["-tf", output], work).split("\n").filter((name) => name && !name.endsWith("/"))
    expect(files.slice(0, 3)).toEqual([".PKGINFO", ".INSTALL", ".MTREE"])
    expect(files).toEqual(expect.arrayContaining([
      "opt/Cogpit/cogpit",
      "opt/Cogpit/cogpit-bun",
      "opt/Cogpit/cogpit-core",
      "usr/lib/Cogpit/server/desktop.js",
      "usr/lib/Cogpit/package-type",
      "usr/share/applications/Cogpit.desktop",
    ]))
    expect(files.some((name) => name.startsWith("usr/bin"))).toBe(false)

    const read = (name: string) => tar(["-xOf", output, name], work)
    expect(read("usr/lib/Cogpit/package-type")).toBe("pacman\n")
    expect(read("usr/share/applications/Cogpit.desktop")).toContain("Exec=/opt/Cogpit/cogpit")
    expect(read(".PKGINFO")).toContain("pkgver = 4.0.0-1\n")
    expect(read(".PKGINFO")).toContain("arch = x86_64\n")
    expect(read(".INSTALL")).toContain("ln -sf /opt/Cogpit/cogpit /usr/bin/cogpit")

    const listing = tar(["-tvf", output], work)
    expect(listing).toMatch(/-rwxr-xr-x\s+0 root\s+root\s+\d+ .* opt\/Cogpit\/cogpit\n/)
  })
})
