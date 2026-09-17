# Declarative connection fixtures

These synthetic fixtures exercise the executor without provider credentials or network calls. `cloudflare.json`, `figma.json`, and `unknown.json` retain the Phase 0 definitions; the prototype suite retains its original 114 cases through a test-only transport adapter. Production transport accepts a declared origin/path and private credential, and returns bounded parsed JSON.

`clickup.json` adds authenticated viewer binding, connection-scoped workspace selection, project-scoped Space/List selection, combined folderless/folder sources, and validated pasted List URLs/IDs. `figma-input.json` validates entered file/design/board URLs with a fixed file request and required response name. It does not require a file-key echo because the documented response does not promise one. The unknown-provider test applies the same entered-resource mechanism without a core provider branch.

Official references checked 2026-09-14:

- [ClickUp authenticated user](https://developer.clickup.com/reference/getauthorizeduser)
- [ClickUp List metadata and ID](https://developer.clickup.com/reference/getlist)
- [ClickUp folderless Lists](https://developer.clickup.com/reference/getfolderlesslists)
- [ClickUp Folders](https://developer.clickup.com/reference/getfolders)
- [Figma file endpoints, URL key extraction and bounded depth](https://developers.figma.com/docs/rest-api/file-endpoints/)

Options are limited to 100 across sources. Inputs validate against exact declared origins and one unique literal path marker, followed by a fixed provider validation request. Child selections require proof of each selected parent. Changing a parent clears descendant selections; the persistence layer must also clear descendants in other project records. HTTP parsing, IP pinning, byte limits and deadlines have separate transport tests. These fixtures do not establish live account permissions or service availability.
