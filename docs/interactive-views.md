# Interactive views

An agent can put a live page in its reply as a fenced `cogpit-view` block.
Cogpit draws it as a card in the timeline, so an explanation can carry
sliders, charts, simulations or a dashboard without another app. Agents learn
it from the bundled `cogpit` skill (`.claude/skills/cogpit/references/views.md`).

A block holds one of two things:

- **A stored view**, `<id>@<n>`: a small React app kept as files on the
  computer that runs the session, built there into one finished page per
  version. This is the default; the agent can update it.
- **An inline page**: the HTML, CSS and JavaScript itself. This was the first
  form; the skill now offers it only to agents that cannot run `view` commands.

## Stored views

The agent runs `cogpit-session view new|build|list|show`
(`server/sessionCli/views.ts`). Each view is a folder under `~/.cogpit/views`
(`COGPIT_VIEWS_HOME` overrides it; `server/views/store.ts`):

```
<id>/view.json            title, project (worktrees fold into their parent), versions
<id>/app/                 the source the agent edits, App.tsx first
<id>/versions/<n>/        immutable: index.html and files.json
```

`view build` reads `app/` (no links, only .tsx/.ts/.jsx/.js/.css/.json, size
limits in `VIEW_LIMITS`), then `server/views/build.ts` compiles each file
reached from `App.tsx` with sucrase, which keeps line numbers. It resolves
every import there: a relative file, or a specifier a kit module provides.
Anything else fails the build with its file and line, so the agent fixes it
before the user sees anything. A build identical to the latest version is not
stored again.

`server/views/document.ts` composes the finished page: base CSS, the frame kit
with a theme placeholder, and every module (kit and app) as JSON in one script
tag, run by a small loader through indirect eval with a `sourceURL`, so runtime
errors name the agent's file and line. The page needs no network and no other
file, so it runs unchanged wherever it is shown.

The kit is built by `scripts/build-view-kit.ts` (`build:generated`, which dev,
the tests, the typechecks and the builds run first; not `postinstall`, since
on Windows esbuild cannot list `node_modules` while `bun install` holds it)
into `generated/view-kit/index.json` from the modules in
`src/viewKit/modules.ts`. The build includes a module only in views that
import one of its specifiers:

| Module | Provides | Size |
| --- | --- | --- |
| `base` (every view) | `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `cogpit/ui` (Preact compat underneath) | ~34 KB |
| `charts` | `cogpit/charts`: line, area, bar, scatter and pie charts as themed SVG on d3-scale and d3-shape | ~78 KB |
| `math` | `cogpit/math` (`Tex`) and `katex`, forced to MathML output | ~263 KB |
| `scene` | `cogpit/scene` (`Scene3D`), `three` and its orbit controls | ~705 KB |
| `d3` | `d3` | ~277 KB |

Only `base` aliases React to Preact. Every other module leaves React's
specifiers external, so it shares the base's instance, and bundles anything
else it uses. Each module's `doc` is written into the skill's
`references/views.md` between its `view-kit` markers by
`bun run sync-cogpit-skill`, whose check fails CI when they drift.

`server/routes/views.ts` serves `GET /api/views` (`?project=` filters; the
Views panel's list), `GET /api/views/<id>/v/<n>`, and `PATCH` (rename, pin) and
`DELETE` on `/api/views/<id>`. A view belongs to the session that made it
(`view.json`'s `sessionId`): the list shows the views of sessions the caller
may see, and the others authorize that session (`authorizeSession`, view to
read, interact to change), so a team member reaches a view exactly as they
reach its session. A view no session made is host-wide, an admin's. A missing
view answers like a hidden one. Deleting removes the source and versions but
keeps `view.json` as a tombstone, so the id stays tied to its session and a
second delete answers the same. `cogpit-session view` applies the same rules.

The card fetches `GET /api/views/<id>/v/<n>` through `authFetch`, which sends
a hub device's session to that device, so the computer that owns a view
always builds and serves it. It swaps the viewer's theme into the placeholder
(`withViewTheme`) and posts the page into the shell. It shows the source files,
and offers the newest version when the reply's is older.

## How a view runs

1. `MarkdownCodeBlock` hands a `cogpit-view` block in an agent's reply to the
   lazily loaded `CogpitView`. Outside an agent's reply, such as in a prompt
   that quotes one, it stays code. Until the reply writes the closing fence,
   the card says the view is being built instead of running half a page.
2. The card frames `/api/views/shell/v1` (`server/views/shell.ts`) with
   `sandbox="allow-scripts"`. The shell answers `ready`; the card then posts the
   page: a stored view's finished page, or an inline view composed by
   `view/document.ts` (theme, base stylesheet, the in-frame kit and the agent's
   markup as the body) with the code of the libraries it uses.
3. The shell's bridge turns each library into a blob URL, swaps the
   `cogpit:lib/<name>` placeholders for them, and writes the page over itself.

The frame kit (`shared/views/frame.ts`) gives the page `window.cogpit` (`theme`, `color`, `onTheme`, `ask`),
reports its height and script errors, and routes link clicks to the parent.

## Security model

The frame has an opaque origin: no cookies, storage or access to Cogpit's DOM
and API. The shell's policy allows inline and blob scripts but no network
(`connect-src`, `img-src`, `font-src` and `media-src` take only `data:` and
`blob:`), no forms, no nested frames and framing only by Cogpit itself.

A sandbox cannot stop a page from navigating its own frame, so the server
refuses any request a browser marks as loading into a frame
(`Sec-Fetch-Dest: iframe`) unless it is for the view or plugin shell
(`server/security.ts`). The app's own policy keeps the frame on Cogpit's
origin, and the desktop app also refuses any navigation of the frame away
from the shell. Under the Vite dev server the app document carries only a
`frame-src` policy, which also allows local previews on `localhost` and
`127.0.0.1`, so a view cannot reach another site there either.

The parent trusts nothing a view posts, because the view's own code can post
the same messages as the kit: sizes are clamped, errors truncated, links must be
plain `http(s)` without credentials, and `open` and `ask` act only while the
frame holds focus, which a page cannot take without the user's click. `ask` only
fills the composer; the user still sends.

A share guest may load the shell and the pages of views its shared session
made (`server/share/allowlist.ts` admits the paths; the route checks the
session). Views another session made show that they could not load.

## Inline libraries

D3, KaTeX (MathML output, so no fonts or stylesheet) and Three.js with
`OrbitControls` ship with the renderer as lazily loaded raw chunks
(`view/libraries.ts`). `build/viewLibraryAliases.ts` maps `@view-lib/<name>` to
the browser builds, which the packages' export maps do not expose. To add one,
add its file there, a loader in `libraries.ts`, its name in `librariesUsed`, and
a row in the skill's table.
