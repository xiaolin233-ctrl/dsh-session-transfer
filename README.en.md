# dsh-session-transfer

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) that moves a whole conversation from one workspace to another **without damaging it** — title, tool calls, token accounting and the ability to keep chatting all survive the move.

It adds one row to the session "⋯" menu in the sidebar: **Move to another workspace…**.

## How "without damaging it" is guaranteed

A session on disk is an append-only event log (`session.v4.jsonl.zstd`: a header frame plus one zstd frame per append batch). The plugin **never rewrites an existing byte**. It replays the log through the official `sessionPersistence` API instead:

1. Read the complete source log (a live session is `sessions.flush()`ed first and storage wins; the in-memory log is only used when storage lags behind).
2. Verify `seq` runs contiguously from 0; a session that is mid-turn is refused so you never copy half a round.
3. `create` a session under a new id in the target workspace, copying the header field by field (`version`, `createdAt`, `isSeeded`, `delegationDepth`, `agentPreset`, `parentSession`) and only pointing `cwd` at the target; `inheritedEventCount` is inherited unchanged.
4. `append` every event in batches of 500, then `flush()`.
5. Close the write handle and **read the copy back**: event count, contiguous seq and last seq must match the source, otherwise it reports `verify-failed` instead of pretending success.
6. `attachSession(newId)` so the copy shows up in the target workspace (this pushes the sidebar update).
7. `sessionProjectionCache.coldSnapshot(...)` to seed the projection cache — that is where a cold session's sidebar title comes from; without it the row would read "Untitled".
8. By default the source session is **archived** (`archiveSession`): archiving only hides it from the group view, deletes nothing, and it can be restored from "Archived". Tick "keep the original" to leave it untouched.

Because the events are replayed verbatim, `session/title` is among them, so the title is preserved for free. A session directory holds only this one log file; attachments live in global storage, so references cannot break.

One trap worth knowing: `session-log-deepseek/delivery-accepted` events carry the session id (v4 requires it to match the header id). A verbatim copy makes the copy unreadable with `SessionFormatError: current-generation delivery marker names the wrong Session`. The plugin therefore rewrites only the markers **the session produced itself** (`seq >= inheritedEventCount`); the inherited prefix (when the copy keeps its `parentSession`) is left alone.

## Install

1. Clone this repository anywhere on your machine (spaces in the path are fine).
2. Install it as a local plugin bundle from a DSH session, pointing at the repository root (the directory with `package.json`):

   ```
   plugin_manager  action: install_bundle  target: <absolute path to the repo>
   ```

   Expect `application: applied` and an empty `warnings` list; `dsh-session-transfer` then appears in the plugin list as enabled / active.
3. **Refresh the browser page** to load the client half (the host half is live as soon as it is installed; no DSH restart needed).

Requirements: a DSH build with plugin-bundle support (host + web client), Node.js ≥ 22.5. Uninstall with `plugin_manager action: remove_bundle target: dsh-session-transfer`.

> The repository *is* the plugin package: no build step, no runtime dependencies. `impl.js` is hot-reloaded on every request, so a page refresh is enough to verify a change.

## Usage

1. Hover a conversation in the sidebar, open the "⋯" menu → **Move to another workspace…**
2. Pick the target workspace, optionally:
   - **Keep the original conversation** (off by default: the original is archived and can be restored).
   - When the workspace has more than one conversation, **move all conversations of this workspace** appears as well — each is copied in turn and subagent sessions are skipped.
3. Click **Move**. When it finishes you can jump straight into the copy with **Open new session**.

Subagent sessions (`header.origin === 'subagent'`) follow their parent; moving one alone would orphan it, so they are always refused and reported individually. Sessions that still need a format migration are refused too (`format-migration-required`), so an old format is never written into a new header.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Host entry: registers the `/dsh-session-transfer` HTTP routes and declares the `webServer` dependency. |
| `impl.js` | The actual migration logic, **re-imported with a cache-busting stamp on every request**, so editing it needs no DSH restart. |
| `client.js` | Browser half: the menu row and the overlay dialog (`sidebar.workspaces.session.menu.item` / `shell.overlay`), using only `--dsw-alias-*` theme tokens and no UI primitives. |
| `cordis.patch.yml` | Inserts the plugin into the host composition. |
| `locale/{zh,en}.json` | Title and description shown on the plugin page. |

## HTTP routes

- `GET /dsh-session-transfer/state?sessionId=…` → `{ ok, workspaces:[{id,title,path,sessionCount}], currentWorkspaceId, sourceSessionIds, session }`
- `POST /dsh-session-transfer/transfer`, body `{ sessionIds:[…], targetWorkspaceId, keepOriginal?:boolean, titles?:{id:title} }` → `{ ok, targetWorkspaceId, targetTitle, targetPath, results:[{ sessionId, ok, newSessionId?, eventCount?, archivedOriginal?, cacheWritten?, note?, code?, message?, partialSessionId? }] }`

Business failures land in the individual `results[]` entries instead of failing the HTTP request, so one bad session does not abort a batch.

## What happens on failure

- `read-failed` / `log-corrupt`: the source log cannot be read or is not contiguous → nothing is written.
- `session-running`: the source is answering → wait for the turn to finish.
- `copy-failed`: writing died halfway → `partialSessionId` is returned for cleanup; the source is untouched.
- `verify-failed`: the read-back check disagreed → `partialSessionId` is returned and the copy is not attached.
- `attach-failed`: the copy exists but could not be attached → `partialSessionId` is returned.
- Archive failure (e.g. the source is still running) → the copy still succeeds; `note` explains that the original was kept.

## Verification

After installing, a one-off self-test plugin ran the real code inside the live host process against two samples — a 26-event unseeded session, and a 1250-event seeded session with `inheritedEventCount = 1248`. Everything passed:

- the copy's `cwd` points at the target workspace, while `createdAt` / `isSeeded` / `delegationDepth` / `agentPreset` / `inheritedEventCount` are all preserved;
- the copy's event array equals the source (apart from the rewritten delivery-marker id), `seq` is contiguous from 0, and the title is preserved;
- the copy appears in the target workspace's `sessionIds` immediately, its projection cache file is written, and the sidebar shows the title;
- the temporary workspaces, session directories and caches used by the self-test were cleaned up; the existing workspaces were untouched.

## License

MIT — see [LICENSE](LICENSE).