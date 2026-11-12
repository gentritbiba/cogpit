// electron-builder afterPack hook: no app ships without cogpit-core, the Rust
// process its server cannot start without (see extraResources in electron-builder.yml).
import { accessSync, constants } from "node:fs"
import { join } from "node:path"

export default function requireCore({ appOutDir, packager, electronPlatformName }) {
  const windows = electronPlatformName === "win32"
  const core = join(packager.getResourcesDir(appOutDir), "bin", windows ? "cogpit-core.exe" : "cogpit-core")
  try {
    accessSync(core, windows ? constants.R_OK : constants.X_OK)
  } catch {
    throw new Error(
      `cogpit-core is missing from the packaged app (${core}). Run \`bun run build:core --release --stage\` `
      + "or put the target's build in core-dist/<platform>-<arch>/ first.",
    )
  }
}
