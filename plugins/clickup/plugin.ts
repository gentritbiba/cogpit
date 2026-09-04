import { ListChecks } from "lucide-react"
import { definePlugin } from "@/plugin-api"
import { ClickUpIndicator, ClickUpPanel } from "./ClickUpPanel"

export default definePlugin({
  id: "clickup",
  workspacePanels: [{
    id: "tasks",
    title: "ClickUp",
    icon: ListChecks,
    component: ClickUpPanel,
    indicator: ClickUpIndicator,
    order: 42,
    defaultSize: "38%",
    minSize: "360px",
    maxSize: "62%",
    when: (context) => context.canAccessHostFiles,
  }],
})
