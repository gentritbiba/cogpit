import type { EditionUiModule } from "./contract"

/**
 * What `@cogpit/edition-ui` resolves to in a build without an edition package's
 * UI, such as a public clone's: nothing to install.
 */
const ABSENT: EditionUiModule | null = null

export default ABSENT
