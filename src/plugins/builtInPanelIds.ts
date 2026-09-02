import { workspacePanelId } from "@/plugin-api"

export const BUILT_IN_PLUGIN_ID = "cogpit"

export const BUILT_IN_WORKSPACE_PANEL_IDS = {
  projectFiles: workspacePanelId(BUILT_IN_PLUGIN_ID, "project-files"),
  fileChanges: workspacePanelId(BUILT_IN_PLUGIN_ID, "file-changes"),
  sessionInfo: workspacePanelId(BUILT_IN_PLUGIN_ID, "session-info"),
} as const
