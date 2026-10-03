import type { CogpitEdition } from "../../shared/contracts/identity"
import { PERSONAL_EDITION } from "./personal"
import type { EditionModule } from "./types"

let installed: EditionModule = PERSONAL_EDITION

/** The running edition's hooks: personal edition until one is installed. */
export function editionModule(): EditionModule {
  return installed
}

/** Replace personal edition with `module`, once per process. */
export function installEdition(module: EditionModule): void {
  if (installed !== PERSONAL_EDITION) {
    throw new Error(`Cogpit's ${installed.edition} edition is already installed`)
  }
  installed = module
}

export function getEdition(): CogpitEdition {
  return installed.edition
}

export function __resetEditionForTest(): void {
  installed = PERSONAL_EDITION
}
