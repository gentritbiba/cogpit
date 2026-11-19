# Publish views to a public link

Status: design approved 2026-11-18, implemented 2026-11-19 (`feat/publish-views`). How it works now lives in `docs/interactive-views.md` and `docs/plugins.md`.

## Goal

A user can publish a stored view (`<id>@<n>`) to a public URL from its card or
the Views panel, update it in place, and take it down. Where it goes is a
plugin's choice, so core names no host. The first host is the personal
`share-docs` worker (https://share-docs.gentritbiba1.workers.dev) that `pub`
already uses.

## Decisions

- Anyone using Cogpit can publish from a button; the destination comes from an
  installed plugin (not a core setting).
- One link per view. Publishing again overwrites the same slug.
- The published page carries both themes and follows the visitor's
  `prefers-color-scheme`.
- Only the user publishes. There is no `cogpit-session view publish`; agents
  cannot make a page public.

## Plugin contract

New contribution, built like `dictation`:

```json
"publish": {
  "title": "Share host",
  "connection": "share",
  "operation": "publish",
  "unpublish": "unpublish",
  "url": "/url",
  "slug": "/slug"
}
```

- `operation` is an upload operation with the new type
  `upload: { type: "html", mimeTypes: ["text/html"], maxBytes }`, capped by
  the existing 8 MiB media limit, taking an optional `slug` argument.
- `unpublish` is a JSON POST operation taking `slug`.
- `url` and `slug` are JSON pointers into the publish answer.
- Validated in `server/plugins/package.ts` beside `dictation`. The install
  review lists "Can publish views publicly to `<origin>`".
- Capability flags: client `views.publish`, host `connections.upload` with
  the html type.
- Several publishing plugins: the Publish button opens a menu of them.

## Composing the public page (client)

`shared/views/publish.ts` takes the stored page and replaces the theme
placeholder with both token sets. The light set is the current one; the dark
set is read from a hidden element that flips the mode (`.dark`, or
`.color-scheme-inverse` under a dark root). The frame kit
picks the set from `prefers-color-scheme` and follows changes. With no Cogpit
parent, `ask` is a no-op and links open normally.

The client composes because it owns the theme tokens.

## Server

`POST /api/views/<id>/v/<n>/publish {pluginId, html}` and
`POST /api/views/<id>/unpublish`:

- `authorizeSession(interact)` on the view's session, plus the plugin lease.
- `manager.publish()` / `manager.unpublish()` mirror `manager.dictate()`:
  send through the connection executor, read `url` and `slug` back.
- On success `view.json` records
  `published: { pluginId, url, slug, version, at }`; unpublish clears it.
- Registered in `server/api-routes.ts`, given an edition `ROUTE_POLICIES`
  entry, never added to the share-guest allowlist.
- A hub device's view is published by that device with its own plugin
  (`authFetch` already routes there).

## UI

Publish button on the view card toolbar and in the Views panel. Once
published: Copy link, Update published (v3 → v5), Unpublish. The card notes
"published v3 · v5 available" when the view has moved on.

## Lifecycle and failures

- Nothing is recorded unless the host answered with a URL.
- Deleting a published view unpublishes it first; if that fails, the delete
  stops and shows the error, so no public page is left that Cogpit forgot.
  The server refuses the delete (409) unless `?leavePublished=1`, which the
  client sends only when the publishing plugin is no longer installed.
- Plugin uninstalled or disabled: the record stays; Copy link works, Update
  and Unpublish are disabled with "Share host is not installed".
- 401 → "Share host rejected the token. Reconnect it in Plugins." Too large
  or unreachable → toast, view unchanged.

## Share host plugin

Dev-signed, installed from file, not bundled; source lives beside the worker
in `~/.agents/tools/share-worker/cogpit-plugin/` because it names a personal
host: `plugin.json` plus
`connections/share.json` with `origin: https://share-docs.gentritbiba1.workers.dev`, bearer
token secret, `publish` and `unpublish` operations. No frame code.

## Worker (`~/.agents/tools/share-worker`)

- `POST /_publish?slug=<optional>`: body is the HTML; writes
  `<slug>/index.html` (random slug when absent, overwrite when given);
  answers `{ url, slug }`.
- `POST /_unpublish {slug}`: removes the slug's objects, as `pub --rm` does.

## Tests

- Manifest validation of `publish` (wrong upload type, missing operation, bad
  pointers).
- `manager.publish` / `unpublish` against a fake executor.
- Route authorization: share guest refused, team viewer without interact
  refused.
- `publish.ts`: both themes embedded, follows system setting, `ask` no-op.
- Worker tests for `/_publish` and `/_unpublish`.
- Live QA: isolated server, dev-signed plugin, throwaway view; publish to the
  real host, check light and dark, update, unpublish, confirm 404.

## Docs

`docs/plugins.md` (contribution), `docs/interactive-views.md`, and the
cogpit skill's `references/views.md` (one line: the user can publish a view
from its card; agents cannot), then `bun run sync-cogpit-skill`.
