import { useState, type ReactNode } from "react"
import { authUrl } from "@/lib/auth"
import { cn } from "@/lib/utils"

/**
 * The icon a project already ships, with the caller's icon behind it.
 *
 * Most repositories contain a picture of themselves; using it costs the user
 * nothing and makes a long project list scannable by shape instead of by
 * reading every path. Anything unresolvable falls straight back, so a project
 * without an icon looks exactly as it did before.
 */
export function ProjectFavicon({
  projectPath,
  fallback,
  className,
}: {
  projectPath: string | null | undefined
  fallback: ReactNode
  className?: string
}) {
  // Remember which path failed rather than that one did, so switching projects
  // does not inherit the previous project's missing icon.
  const [failedPath, setFailedPath] = useState<string | null>(null)

  if (!projectPath || failedPath === projectPath) return <>{fallback}</>

  return (
    <img
      key={projectPath}
      src={authUrl(`/api/project-icon?cwd=${encodeURIComponent(projectPath)}`)}
      alt=""
      aria-hidden
      loading="lazy"
      decoding="async"
      onError={() => setFailedPath(projectPath)}
      className={cn("size-3.5 shrink-0 rounded-[3px] object-contain", className)}
    />
  )
}
