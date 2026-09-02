import { plugins } from "../../plugins"
import { collectWorkspacePanels } from "@/plugin-api"
import { builtInWorkspacePlugin } from "@/components/workspace-panels/builtInWorkspacePlugin"

export const workspacePanels = collectWorkspacePanels([
  builtInWorkspacePlugin,
  ...plugins,
])
