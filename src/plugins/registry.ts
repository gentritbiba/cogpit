import { collectWorkspacePanels } from "@/plugin-api"
import { builtInWorkspacePlugin } from "@/components/workspace-panels/builtInWorkspacePlugin"

export const workspacePanels = collectWorkspacePanels([
  builtInWorkspacePlugin,
])
