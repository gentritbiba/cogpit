import { Circle } from "lucide-react"
import { describe, expect, it } from "vitest"
import {
  collectWorkspacePanels,
  definePlugin,
  workspacePanelId,
  type WorkspacePanelProps,
} from "@/plugin-api"

function EmptyPanel(_props: WorkspacePanelProps) {
  return null
}

describe("workspace panel registry", () => {
  it("qualifies and orders compile-time panel contributions", () => {
    const panels = collectWorkspacePanels([
      definePlugin({
        id: "deployments",
        workspacePanels: [{
          id: "vercel",
          title: "Vercel deployments",
          icon: Circle,
          component: EmptyPanel,
          order: 20,
        }],
      }),
      definePlugin({
        id: "build-tools",
        workspacePanels: [{
          id: "status",
          title: "Build status",
          icon: Circle,
          component: EmptyPanel,
          order: 10,
        }],
      }),
    ])

    expect(panels.map((panel) => panel.id)).toEqual([
      "build-tools.status",
      "deployments.vercel",
    ])
    expect(panels[0]).toMatchObject({
      pluginId: "build-tools",
      localId: "status",
    })
    expect(workspacePanelId("build-tools", "status")).toBe("build-tools.status")
  })

  it("rejects invalid and duplicate ids during registration", () => {
    expect(() => collectWorkspacePanels([
      { id: "Not Valid", workspacePanels: [] },
    ])).toThrow('Invalid Cogpit plugin id "Not Valid"')

    expect(() => collectWorkspacePanels([
      { id: "git", workspacePanels: [] },
      { id: "git", workspacePanels: [] },
    ])).toThrow('Duplicate Cogpit plugin id "git"')

    expect(() => collectWorkspacePanels([{
      id: "git",
      workspacePanels: [
        { id: "actions", title: "One", icon: Circle, component: EmptyPanel },
        { id: "actions", title: "Two", icon: Circle, component: EmptyPanel },
      ],
    }])).toThrow('Duplicate Cogpit workspace panel id "git.actions"')
  })
})
