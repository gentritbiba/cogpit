import { initializePluginManager } from "./manager"
import { captureLegacyPluginHost, type LegacyHostClassification } from "./legacyHost"
import { appSeedClientDescriptor, loadAppPluginSeeds } from "./appSeeds"

export async function initializeAppPlugins(dataRoot: string, options: { legacyHost?: LegacyHostClassification; legacyClickUpPath?: string } = {}) {
  const legacyHost = options.legacyHost ?? await captureLegacyPluginHost(dataRoot)
  const manager = await initializePluginManager(dataRoot, { legacyHost, appSeeds: loadAppPluginSeeds() })
  if (manager.snapshot().available) {
    if (legacyHost.classification === "indeterminate") {
      manager.reportMigrationIssue("Existing plugin settings need inspection. No optional plugins were installed automatically; you can still install a package here.")
      return manager
    }
    try {
      const migration = await manager.store.migrateLegacySeeds({ client: appSeedClientDescriptor(), authorize: () => {} })
      if (migration.failures.length) manager.reportMigrationIssue(`Could not migrate ${migration.failures.map((failure) => failure.id).join(", ")}. Review the available packages and compatibility requirements.`)
      if (options.legacyClickUpPath && manager.snapshot().plugins.some((plugin) => plugin.id === "cogpit.clickup")) {
        await manager.prepareLegacyClickUp({ path: options.legacyClickUpPath, classification: legacyHost, authorize: () => {} })
      }
    } catch {
      manager.reportMigrationIssue("Saved plugin settings could not be migrated. Existing files were retained. You can manage installed plugins or configure a connection here.")
    }
  }
  return manager
}
