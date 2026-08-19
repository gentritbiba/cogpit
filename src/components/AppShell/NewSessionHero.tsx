import { projectName, shortPath } from "@/lib/format"

/**
 * The question a new session opens on.
 *
 * Pairs with a `justify-center` parent so the composer sits in the middle of an
 * empty workspace rather than pinned to the footer. The composer itself stays
 * in its normal slot in the tree, so sending the first message re-lays out the
 * page without remounting the input or dropping focus.
 */
export function NewSessionHeadline({ projectPath }: { projectPath: string | null }) {
  const name = projectPath ? projectName(projectPath) : null

  return (
    <div className="flex flex-col items-center gap-2 px-4 text-center">
      <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
        {name ? (
          <>
            What should we build in{" "}
            <span>{name}</span>
            ?
          </>
        ) : (
          "What should we build?"
        )}
      </h1>
      {projectPath && (
        <p className="font-mono text-xs text-muted-foreground">{shortPath(projectPath)}</p>
      )}
    </div>
  )
}
