# Library

The Library panel, beside the chat, keeps what agents share in their replies so
you can find it again without scrolling back through a conversation.

## Tabs

- **Media**: images and videos a reply shows with `![alt](/absolute/path)` or a
  bare media path alone on a line. Images open together in the image viewer and
  videos in a player.
- **Links**: `http(s)` links in replies, from markdown links, autolinks and bare
  URLs. A link shared again lists once, with how many times it was shared. Dev
  servers on the same computer (`localhost`, `127.0.0.1`) are left out.
- **Files**: absolute-path links to documents, such as reports, PDFs, HTML,
  Markdown, CSV, office files and archives. A link with a line number
  (`file.ts:12`) is a code reference, so it is left out. So are source files.
- **Views**: the stored [interactive views](interactive-views.md), with pin,
  rename and delete. Open one to pick a version or read its source.

Text inside code blocks and inline code is never collected, and neither is a
subagent's own text.

The scope switch chooses **Session** (the open session), **Project** (every
session in the project, with worktrees folded into their parent checkout) or
**All**. The filter matches labels and paths. Each item can take you to the
reply that shared it, copy its link or path, or leave the library. Removing an
item keeps it in the conversation.

## Kept copies

Agents often save screenshots and recordings under `/tmp`, which the system
clears. When the library collects a local image, video or document, it copies
the file into its own folder by content hash. The panel shows that copy once the
original is gone, and a path an agent overwrites keeps each version a reply
showed. A file written more than two minutes after the reply that shared it is
not what the reply showed, so it is not copied.

Limits: 25 MB per image or document, 250 MB per video, and 2 GB in total. When
the total is full, the oldest copies make room for newer ones.

## How it works

The server's memory indexer already reads every session of every agent CLI and
account into `~/.cogpit/memory/memory.db`. After each indexing pass, the library
reads the reply text of transcripts that changed since its last pass from that
store, extracts what they shared, and records each occurrence in its own SQLite
store. It then copies new local files in the background.

| Path | Contents |
| --- | --- |
| `~/.cogpit/library/library.db` | Every occurrence (session, turn, time, project) and the kept copies |
| `~/.cogpit/library/files/` | Kept copies, named by SHA-256 |

The library sits beside the memory store it is fed from, so a server started
with its own `COGPIT_MEMORY_DIR` keeps its own library; `COGPIT_LIBRARY_HOME`
moves it anywhere. An occurrence stays when its transcript is
rewritten or deleted. Only removing it from the panel takes it out.

`GET /api/library?scope=session|project|all&session=&project=&tab=media|link|file&q=&limit=&before=`
lists one tab, newest first, with per-tab counts, the view ids the scope's
replies showed, and the indexer's progress. `DELETE /api/library/items/<id>`
removes an item and the other mentions it stands for. As with conversation
search, a caller sees only items from sessions they may see. Items whose
transcript is gone are shown only to a host-wide admin.
