import { accessAtLeast, type SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import { formatViewReference, isViewId } from "../../shared/views/stored"
import { accessLevelOf } from "../edition"
import { buildView, formatBuildError } from "../views/build"
import { invalidViewIdMessage, projectOfCwd, viewStore, type ViewRecord, type ViewStore } from "../views/store"
import { EXIT, json, parseArgs, UsageError, type CliInvocation, type CliOutput } from "./args"

export const VIEW_USAGE = `  view new ID [--title TITLE]
        Start an interactive view: a small React app in its own folder on
        this machine, beginning with App.tsx. Prints the folder; edit the files
        there with your usual tools. ID is lowercase words joined by hyphens.
  view build ID [--title TITLE]
        Compile the view and store it as its next version. Prints each
        problem as file:line, or the block to put in your reply.
  view list [--all]         This project's views (--all: every project), newest first.
  view show ID              A view's folder, title and versions.`

function idArg(args: string[], verb: string): string {
  const id = args.shift()
  if (!id) throw new UsageError(`view ${verb} needs a view id`)
  if (!isViewId(id)) throw new UsageError(invalidViewIdMessage(id))
  return id
}

function titleFromId(id: string): string {
  const words = id.replace(/-/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function summary(store: ViewStore, record: ViewRecord) {
  return {
    id: record.id,
    title: record.title,
    project: record.project,
    folder: store.appDir(record.id),
    latestVersion: record.versions.at(-1)?.version ?? null,
    updatedAt: record.updatedAt,
  }
}

/**
 * Whether the caller may use a view made by `sessionId`, as they may that
 * session: an admin may use any, and a view no session made is an admin's.
 */
async function mayUse(inv: CliInvocation, sessionId: string | undefined, needed: SessionAccessLevel): Promise<boolean> {
  if (inv.admin) return true
  if (!inv.req || !sessionId) return false
  const level = await accessLevelOf(inv.req, sessionId)
  return level !== null && accessAtLeast(level, needed)
}

/** The view, if the caller may use it at `needed`; an unreachable view answers like a missing one. */
async function reachable(inv: CliInvocation, store: ViewStore, id: string, needed: SessionAccessLevel): Promise<ViewRecord> {
  const record = await store.read(id)
  if (!record || !(await mayUse(inv, record.sessionId, needed))) {
    throw new UsageError(`No view "${id}" on this machine${needed === "interact" ? `; start one with: cogpit-session view new ${id}` : ""}`)
  }
  return record
}

function replyBlock(id: string, version: number): string {
  return `\`\`\`cogpit-view\n${formatViewReference({ id, version })}\n\`\`\``
}

export async function viewCommand(inv: CliInvocation, rest: string[], store: ViewStore = viewStore()): Promise<CliOutput> {
  const [verb, ...tail] = rest
  switch (verb) {
    case "new": {
      const args = parseArgs(tail, ["title"], [])
      const id = idArg(args.positionals, "new")
      if (!(await mayUse(inv, inv.callerSessionId, "interact"))) {
        throw new UsageError("view new needs COGPIT_SESSION_ID of a session you may work in; run it from a Cogpit session")
      }
      const record = await store.create({ id, title: args.values.get("title")?.trim() || titleFromId(id), project: projectOfCwd(inv.cwd), sessionId: inv.callerSessionId })
      return json({
        ...summary(store, record),
        next: `Write the view in ${store.appDir(id)} (App.tsx default-exports the component), then run: cogpit-session view build ${id}`,
      })
    }
    case "build": {
      const args = parseArgs(tail, ["title"], [])
      const id = idArg(args.positionals, "build")
      const record = await reachable(inv, store, id, "interact")
      const title = args.values.get("title")?.trim() || record.title
      const files = await store.readSources(id)
      const built = buildView({ title, files })
      if (!built.ok) return json({ id, built: false, errors: built.errors.map(formatBuildError) }, EXIT.error)
      const { version, created } = await store.addVersion(id, { files, html: built.html, sessionId: inv.callerSessionId, title })
      return json({
        id,
        built: true,
        version: version.version,
        ...(created ? {} : { note: "Nothing changed since this version, so no new version was stored" }),
        reply: replyBlock(id, version.version),
        next: "Put the reply block in your answer where the view should appear. Script errors at runtime show under the card for the user to send back",
      })
    }
    case "list": {
      const args = parseArgs(tail, [], ["all"])
      const project = projectOfCwd(inv.cwd)
      const records = (await store.list()).filter((record) => args.switches.has("all") || record.project === project)
      const usable = await Promise.all(records.map((record) => mayUse(inv, record.sessionId, "view")))
      return json(records.filter((_, index) => usable[index]).map((record) => summary(store, record)))
    }
    case "show": {
      const id = idArg(tail, "show")
      const record = await reachable(inv, store, id, "view")
      return json({ ...summary(store, record), versions: record.versions.map(({ version, createdAt }) => ({ version, createdAt })) })
    }
    default:
      throw new UsageError(verb ? `Unknown view command "${verb}"` : "view needs a command: new, build, list or show")
  }
}
