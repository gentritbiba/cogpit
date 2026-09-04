import { Github } from "lucide-react"
import { definePlugin } from "@/plugin-api"
import { GitHubIndicator, GitHubPanel } from "./GitHubPanel"

export default definePlugin({
  id: "github",
  workspacePanels: [{
    id: "repository",
    title: "GitHub",
    icon: Github,
    component: GitHubPanel,
    indicator: GitHubIndicator,
    order: 40,
    defaultSize: "38%",
    minSize: "360px",
    maxSize: "62%",
    when: (context) => context.canAccessHostFiles && context.projectPath !== null,
  }],
})
