import type { ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type SidebarPlace = "sessions" | "views"

/**
 * The sidebar's two places, sessions and the views agents built, behind one
 * switch at the top. Where the layout has no view panel there is nothing to
 * switch to, so the sessions show alone.
 */
export function SidebarPlaces({ place, onPlaceChange, views, children }: {
  place: SidebarPlace
  /** Absent where views cannot be shown. */
  onPlaceChange?: (place: SidebarPlace) => void
  views: ReactNode
  /** The sessions place. */
  children: ReactNode
}) {
  if (!onPlaceChange) return <div className="flex h-full min-h-0 flex-col">{children}</div>
  return (
    <Tabs
      value={place}
      onValueChange={(value) => onPlaceChange(value === "views" ? "views" : "sessions")}
      className="h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-0"
    >
      <TabsList aria-label="Sidebar" className="mx-2.5 mt-1 mb-1.5 w-auto">
        <TabsTrigger value="sessions" data-testid="sidebar-place-sessions">Sessions</TabsTrigger>
        <TabsTrigger value="views" data-testid="sidebar-place-views">Views</TabsTrigger>
      </TabsList>
      <TabsContent value="sessions" className="flex min-h-0 flex-col">{children}</TabsContent>
      <TabsContent value="views" className="flex min-h-0 flex-col">{views}</TabsContent>
    </Tabs>
  )
}
