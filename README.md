# Claude Memory Explorer

A local, read-only web UI to browse what Claude Code keeps in its memory (`~/.claude/projects/*/memory/`): the memories themselves, how often they are actually used, how they link to each other, and whether the memory index is healthy.

```sh
node server.mjs            # opens http://localhost:4321 in your browser
node server.mjs --port 5000 --no-open
```

No dependencies (Node ≥ 20). The server only listens on `127.0.0.1` and never modifies anything under `~/.claude`. It honours `CLAUDE_CONFIG_DIR` if you have it set.

## Views

Switch views from the sidebar or with the keys `1`–`4`. Every view can be filtered by project.

- **Memories** — search (`/`, `Esc`, `↑` `↓`), filter by type, and sort by date, reads, last read or name. Each memory shows how many times it has been read, in how many sessions (and how many besides the one that created it), and when it was last read. `[[memory]]` links are clickable, with backlinks.
- **Graph** — links between memories (`[[name]]` and markdown links to another memory). Colour is the memory type, size is reads (or links), and memories that were never read are hollow. Groups of tightly linked memories are drawn as soft hulls labelled with their topic. Hover a node to highlight its neighbours, click it for a detail card, double-click to open it. Scroll to zoom, drag to pan. Below the graph, the group list: large connected sets are split into communities (Louvain) — handy to decide what to review or merge. Click a group to zoom into it.
- **Stats** — memories by project, type and month; reads, writes and sessions per week; `MEMORY.md` index size against the 25 KB limit; most-read memories and which types get read.
- **Health** — index near or over the limit (Claude Code only loads the first 200 lines or 25 KB of `MEMORY.md`), memories missing from the index, broken links, never-read memories and empty memory folders.

## Where usage data comes from

`usage.mjs` reads the session transcripts (`~/.claude/projects/**/*.jsonl`) and extracts:

- **index loads**: the `AutoMem` attachment with `MEMORY.md`, at session start or after compaction;
- **reads**: `Read`, file attachments, or `cat`/`head`/`grep` via Bash on a memory file;
- **writes**: `Write`, `Edit`, or redirects/`sed -i` via Bash.

There is no way to tell whether Claude used an index line without opening the memory; only explicit reads count.

Results are cached in `~/.cache/memory-explorer/usage.json` (or `$XDG_CACHE_HOME`). The first scan takes a few seconds; after that only changed transcripts are re-read (around 100 ms). Claude Code deletes old transcripts (`cleanupPeriodDays`), but the cache keeps what it already analysed, so usage history keeps growing even after transcripts are gone. Delete that file to start over.

## Files

- `server.mjs` — HTTP server and memory loading
- `usage.mjs` — usage analysis with an incremental cache
- `index.html` — markup and styles
- `app.js` — UI logic
- `charts.js` — SVG charts
- `graph.js` — force layout, groups, hulls and pan/zoom for the graph
