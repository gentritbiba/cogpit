import { authFetch } from "@/lib/auth"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"
import type { UiFeature } from "../../shared/contracts/telemetry"

/** Count a feature only the renderer sees. The server ignores it when usage data is off. */
export function reportUiFeature(feature: UiFeature): void {
  void (async () => {
    await authFetch("/api/telemetry/feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feature }),
    })
  })().catch(() => {})
}

const PANEL_FEATURES: Readonly<Record<string, UiFeature>> = {
  [BUILT_IN_WORKSPACE_PANEL_IDS.crew]: "panel.crew",
  [BUILT_IN_WORKSPACE_PANEL_IDS.status]: "panel.status",
  [BUILT_IN_WORKSPACE_PANEL_IDS.worktrees]: "panel.worktrees",
  [BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles]: "panel.project_files",
  [BUILT_IN_WORKSPACE_PANEL_IDS.browser]: "panel.browser",
  [BUILT_IN_WORKSPACE_PANEL_IDS.library]: "panel.library",
  [BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges]: "panel.file_changes",
  [BUILT_IN_WORKSPACE_PANEL_IDS.automations]: "panel.automations",
  [BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo]: "panel.session_info",
}

/** The feature a workspace panel counts as; plugin panels are named by their authors, so they count as none. */
export function panelFeature(panelId: string | null | undefined): UiFeature | undefined {
  return panelId ? PANEL_FEATURES[panelId] : undefined
}
