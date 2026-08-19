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
    <div className="flex flex-col items-center gap-1.5 px-4 text-center">
      <h1 className="text-balance text-lg font-medium text-foreground/90">
        {name ? (
          <>
            What should we build in{" "}
            <span className="underline decoration-dotted decoration-muted-foreground/40 underline-offset-4">
              {name}
            </span>
            ?
          </>
        ) : (
          "What should we build?"
        )}
      </h1>
      {projectPath && (
        <p className="font-mono text-[11px] text-muted-foreground/60">{shortPath(projectPath)}</p>
      )}
    </div>
  )
}
