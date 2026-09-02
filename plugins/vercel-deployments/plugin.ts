import { Rocket } from "lucide-react"
import { definePlugin } from "@/plugin-api"
import { VercelDeploymentsIndicator, VercelDeploymentsPanel } from "./VercelDeploymentsPanel"

export default definePlugin({
  id: "vercel-deployments",
  workspacePanels: [{
    id: "deployments",
    title: "Vercel Deployments",
    icon: Rocket,
    component: VercelDeploymentsPanel,
    indicator: VercelDeploymentsIndicator,
    order: 45,
    defaultSize: "42%",
    minSize: "380px",
    maxSize: "68%",
    when: (context) => context.canAccessHostFiles && context.projectPath !== null,
  }],
})
