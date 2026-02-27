// Re-export everything from the config-browser/ directory module
// so existing imports from "./config-browser" or "../routes/config-browser" continue to work.
export {
  registerConfigBrowserRoutes,
  scanDir,
  buildGlobalSection,
  buildProjectSection,
  buildPluginSections,
  isAllowedConfigPath,
  isUserOwned,
  getFileType,
  templates,
} from "./config-browser/index"
export type { ConfigTreeItem, ConfigTreeSection } from "./config-browser/index"
