import { ProviderUpdateBanner } from "@/components/ProviderUpdateBanner"
import { UpdateBanner } from "@/components/UpdateBanner"
import { useAppContext } from "@/contexts/AppContext"
import { DesktopOverlays } from "./DesktopOverlays"
import { DesktopWorkspace } from "./DesktopWorkspace"
import type { DesktopAppShellProps } from "./desktopTypes"

/** Desktop-only application composition: workspace and global overlays. */
export function DesktopAppShell({
  navigation,
  sessionView,
  project,
  chrome,
}: DesktopAppShellProps) {
  const { theme } = useAppContext()

  return (
    <div className={`${theme.themeClasses} flex h-dvh flex-col bg-background text-foreground`}>
      {chrome.backgroundServers}
      <UpdateBanner />
      <ProviderUpdateBanner />

      <DesktopWorkspace
        navigation={navigation}
        sessionView={sessionView}
        project={project}
        chrome={chrome}
      />

      <DesktopOverlays
        navigation={navigation}
        project={project}
        chrome={chrome}
      />
    </div>
  )
}
