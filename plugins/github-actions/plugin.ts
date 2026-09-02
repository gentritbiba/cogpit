import { Workflow } from "lucide-react"
import { definePlugin } from "@/plugin-api"
import { GitHubActionsIndicator, GitHubActionsPanel } from "./GitHubActionsPanel"

export default definePlugin({
  id: "github-actions",
  workspacePanels: [{
    id: "runs",
    title: "GitHub Actions",
    icon: Workflow,
    component: GitHubActionsPanel,
    indicator: GitHubActionsIndicator,
    order: 40,
    defaultSize: "38%",
    minSize: "360px",
    maxSize: "62%",
    when: (context) => context.canAccessHostFiles && context.projectPath !== null,
  }],
})
