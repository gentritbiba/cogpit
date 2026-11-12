import { join } from "node:path"
import { CORE_BINARY_NAME } from "../server/core/binary"

/** cogpit-core in an installed app: electron-builder's extraResources put it in `<resources>/bin/`. */
export function packagedCoreBinary(resourcesPath: string): string {
  return join(resourcesPath, "bin", CORE_BINARY_NAME)
}
